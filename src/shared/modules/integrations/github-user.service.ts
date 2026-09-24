import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { database } from "../../../core/database/mysql.js";
import { decryptSecret, encryptSecret } from "../../security/secrets.js";
import {
	exchangeGitHubUserCode,
	getAuthenticatedGitHubUser,
	githubAuthorizationErrorCode,
	type GitHubUserInstallationAccess,
	type GitHubUserTokens,
	listGitHubUserInstallationAccess,
	refreshGitHubUserToken,
} from "./github-app.js";

type GitHubCredentials = {
	accessToken: string;
	refreshToken: string | null;
};

type ConnectionRow = RowDataPacket & {
	id: string;
	githubUserId: string;
	githubLogin: string;
	installationId: string;
	encryptedCredentials: Buffer;
	tokenExpiresAt: Date | null;
	refreshTokenExpiresAt: Date | null;
};

export class GitHubIntegrationError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "GitHubIntegrationError";
	}
}

function expiration(seconds: number | null) {
	return seconds === null ? null : new Date(Date.now() + seconds * 1000);
}

function credentials(
	tokens: GitHubUserTokens,
	previousRefreshToken?: string | null,
) {
	return {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken ?? previousRefreshToken ?? null,
	} satisfies GitHubCredentials;
}

function parseCredentials(payload: Buffer) {
	const parsed = JSON.parse(
		decryptSecret(payload),
	) as Partial<GitHubCredentials>;
	if (!parsed.accessToken || typeof parsed.accessToken !== "string")
		throw new GitHubIntegrationError(
			"github_reauthorization_required",
			"Reconnect your GitHub account to continue.",
		);
	return {
		accessToken: parsed.accessToken,
		refreshToken:
			typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
	} satisfies GitHubCredentials;
}

async function activeConnection(userId: string) {
	const [rows] = await database().query<ConnectionRow[]>(
		`SELECT BIN_TO_UUID(id) AS id,github_user_id AS githubUserId,
            github_login AS githubLogin,installation_id AS installationId,
            encrypted_credentials AS encryptedCredentials,
            token_expires_at AS tokenExpiresAt,
            refresh_token_expires_at AS refreshTokenExpiresAt
     FROM github_user_connections
     WHERE user_id=UUID_TO_BIN(?) AND disconnected_at IS NULL LIMIT 1`,
		[userId],
	);
	const connection = rows[0];
	if (!connection)
		throw new GitHubIntegrationError(
			"github_user_authorization_required",
			"Connect your GitHub account in Settings before selecting a repository.",
		);
	return connection;
}

async function accessToken(connection: ConnectionRow) {
	const stored = parseCredentials(connection.encryptedCredentials);
	const refreshAt = Date.now() + 5 * 60 * 1000;
	if (
		connection.tokenExpiresAt === null ||
		connection.tokenExpiresAt.getTime() > refreshAt
	)
		return stored.accessToken;

	if (
		!stored.refreshToken ||
		(connection.refreshTokenExpiresAt !== null &&
			connection.refreshTokenExpiresAt.getTime() <= Date.now())
	)
		throw new GitHubIntegrationError(
			"github_reauthorization_required",
			"Your GitHub authorization expired. Reconnect your GitHub account.",
		);

	try {
		const refreshed = await refreshGitHubUserToken(stored.refreshToken);
		const nextCredentials = credentials(refreshed, stored.refreshToken);
		await database().execute(
			`UPDATE github_user_connections SET encrypted_credentials=?,token_expires_at=?,
         refresh_token_expires_at=?,installation_id=?,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?) AND disconnected_at IS NULL`,
			[
				encryptSecret(JSON.stringify(nextCredentials)),
				expiration(refreshed.expiresIn),
				refreshed.refreshTokenExpiresIn === null
					? connection.refreshTokenExpiresAt
					: expiration(refreshed.refreshTokenExpiresIn),
				connection.installationId,
				connection.id,
			],
		);
		return nextCredentials.accessToken;
	} catch (error) {
		const code = githubAuthorizationErrorCode(error);
		if (code)
			throw new GitHubIntegrationError(
				code,
				"Your GitHub authorization must be renewed.",
			);
		throw error;
	}
}

async function installationsForUser(token: string) {
	try {
		const access = await listGitHubUserInstallationAccess(token);
		if (access.length === 0)
			throw new GitHubIntegrationError(
				"github_installation_access_required",
				"Install Legacy Hosting Deployments on your GitHub account or an organization you can access, then connect again.",
			);
		if (!access.some((entry) => entry.repositories.length > 0))
			throw new GitHubIntegrationError(
				"github_no_repository_access",
				"Your GitHub account has no repositories with read and write access available to Legacy Hosting Deployments.",
			);
		return access;
	} catch (error) {
		if (error instanceof GitHubIntegrationError) throw error;
		const code = githubAuthorizationErrorCode(error);
		if (code === "github_sso_required")
			throw new GitHubIntegrationError(
				code,
				"Authorize Legacy Hosting Deployments for your organization's SSO, then reconnect GitHub.",
			);
		if (code)
			throw new GitHubIntegrationError(
				code,
				"Reconnect your GitHub account to continue.",
			);
		throw error;
	}
}

function primaryInstallationId(access: GitHubUserInstallationAccess[]) {
	const primary = access[0];
	if (!primary)
		throw new GitHubIntegrationError(
			"github_installation_access_required",
			"No GitHub App installation is available to this user.",
		);
	return primary.installation.id;
}

async function saveUserConnection(
	userId: string,
	githubUser: { id: number; login: string },
	installationId: number,
	tokens: GitHubUserTokens,
) {
	const [identityRows] = await database().query<
		(RowDataPacket & { userId: string })[]
	>(
		`SELECT BIN_TO_UUID(user_id) AS userId FROM github_user_connections
     WHERE github_user_id=? AND user_id<>UUID_TO_BIN(?) LIMIT 1`,
		[githubUser.id, userId],
	);
	if (identityRows[0])
		throw new GitHubIntegrationError(
			"github_account_already_connected",
			"This GitHub account is already connected to another Legacy Hosting account.",
		);

	const [existingRows] = await database().query<
		(RowDataPacket & { id: string; githubUserId: string })[]
	>(
		`SELECT BIN_TO_UUID(id) AS id,github_user_id AS githubUserId
		 FROM github_user_connections WHERE user_id=UUID_TO_BIN(?) LIMIT 1`,
		[userId],
	);
	const connectionId = existingRows[0]?.id ?? randomUUID();
	const encrypted = encryptSecret(JSON.stringify(credentials(tokens)));
	if (existingRows[0]) {
		await database().execute(
			`UPDATE github_user_connections SET github_user_id=?,github_login=?,installation_id=?,
         encrypted_credentials=?,token_expires_at=?,refresh_token_expires_at=?,
         disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?)`,
			[
				githubUser.id,
				githubUser.login,
				installationId,
				encrypted,
				expiration(tokens.expiresIn),
				expiration(tokens.refreshTokenExpiresIn),
				connectionId,
			],
		);
	} else {
		await database().execute(
			`INSERT INTO github_user_connections
       (id,user_id,github_user_id,github_login,installation_id,encrypted_credentials,
        token_expires_at,refresh_token_expires_at)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?)`,
			[
				connectionId,
				userId,
				githubUser.id,
				githubUser.login,
				installationId,
				encrypted,
				expiration(tokens.expiresIn),
				expiration(tokens.refreshTokenExpiresIn),
			],
		);
	}
	if (existingRows[0]) {
		await database().execute(
			"DELETE FROM github_user_repository_access WHERE connection_id=UUID_TO_BIN(?)",
			[connectionId],
		);
		await database().execute(
			"DELETE FROM github_user_installations WHERE connection_id=UUID_TO_BIN(?)",
			[connectionId],
		);
	}
	return connectionId;
}

async function synchronizeRepositoryAccess(
	connectionId: string,
	teamId: string,
	access: GitHubUserInstallationAccess[],
) {
	const connection = await database().getConnection();
	try {
		await connection.beginTransaction();
		await connection.execute(
			`DELETE a FROM github_user_repository_access a
			 JOIN integrations i ON i.id=a.integration_id
			 WHERE a.connection_id=UUID_TO_BIN(?) AND i.team_id=UUID_TO_BIN(?)`,
			[connectionId, teamId],
		);
		await connection.execute(
			`DELETE u FROM github_user_installations u
			 JOIN integrations i ON i.id=u.integration_id
			 WHERE u.connection_id=UUID_TO_BIN(?) AND i.team_id=UUID_TO_BIN(?)`,
			[connectionId, teamId],
		);
		const integrationIds: string[] = [];
		for (const { installation, repositories } of access) {
			const integrationId = randomUUID();
			await connection.execute(
				`INSERT INTO integrations
       (id,team_id,provider,auth_method,connection_scope,external_account_id,display_name,
        encrypted_credentials,metadata,disconnected_at)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'github','oauth','customer',?,?,?,?,NULL)
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),metadata=VALUES(metadata),
         disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP(3)`,
				[
					integrationId,
					teamId,
					String(installation.id),
					installation.account.login,
					encryptSecret(JSON.stringify({ installationId: installation.id })),
					JSON.stringify({
						accountId: installation.account.id,
						accountType: installation.account.type,
						repositorySelection: installation.repository_selection,
						permissions: installation.permissions,
					}),
				],
			);
			const [integrationRows] = await connection.query<
				(RowDataPacket & { id: string })[]
			>(
				`SELECT BIN_TO_UUID(id) AS id FROM integrations
       WHERE team_id=UUID_TO_BIN(?) AND provider='github' AND external_account_id=? LIMIT 1`,
				[teamId, String(installation.id)],
			);
			const storedIntegrationId = integrationRows[0]?.id;
			if (!storedIntegrationId)
				throw new Error("GitHub integration could not be stored");
			integrationIds.push(storedIntegrationId);

			await connection.execute(
				`INSERT INTO integration_resources
       (id,integration_id,resource_type,external_resource_id,display_name,enabled,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'account',?,?,TRUE,?)
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),enabled=TRUE,
         metadata=VALUES(metadata),updated_at=CURRENT_TIMESTAMP(3)`,
				[
					randomUUID(),
					storedIntegrationId,
					String(installation.account.id),
					installation.account.login,
					JSON.stringify({ type: installation.account.type }),
				],
			);
			await connection.execute(
				`INSERT INTO github_user_installations
				 (connection_id,integration_id,installation_id,account_login,account_type,
				  repository_selection,permissions)
				 VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?)`,
				[
					connectionId,
					storedIntegrationId,
					installation.id,
					installation.account.login,
					installation.account.type,
					installation.repository_selection,
					JSON.stringify(installation.permissions),
				],
			);
			for (const repository of repositories) {
				await connection.execute(
					`INSERT INTO integration_resources
         (id,integration_id,resource_type,external_resource_id,display_name,enabled,metadata)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'repository',?,?,TRUE,?)
         ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),enabled=TRUE,
           metadata=VALUES(metadata),updated_at=CURRENT_TIMESTAMP(3)`,
					[
						randomUUID(),
						storedIntegrationId,
						String(repository.id),
						repository.full_name,
						JSON.stringify({
							private: repository.private,
							defaultBranch: repository.default_branch,
							htmlUrl: repository.html_url,
						}),
					],
				);
				await connection.execute(
					`INSERT INTO github_user_repository_access
         (connection_id,integration_id,repository_id,permissions)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?)`,
					[
						connectionId,
						storedIntegrationId,
						String(repository.id),
						JSON.stringify(repository.permissions ?? {}),
					],
				);
			}
		}
		await connection.commit();
		return integrationIds;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

async function visibleRepositories(teamId: string, userId: string) {
	const [rows] = await database().query<
		(RowDataPacket & {
			id: string;
			integrationId: string;
			repositoryId: string;
			fullName: string;
			metadata: string | Record<string, unknown> | null;
			permissions: string | Record<string, unknown> | null;
		})[]
	>(
		`SELECT BIN_TO_UUID(r.id) AS id,BIN_TO_UUID(i.id) AS integrationId,
            r.external_resource_id AS repositoryId,r.display_name AS fullName,
            r.metadata,a.permissions
     FROM github_user_repository_access a
     JOIN github_user_connections c ON c.id=a.connection_id
     JOIN integrations i ON i.id=a.integration_id
     JOIN integration_resources r ON r.integration_id=i.id
       AND r.resource_type='repository' AND r.external_resource_id=a.repository_id
     WHERE c.user_id=UUID_TO_BIN(?) AND c.disconnected_at IS NULL
       AND i.team_id=UUID_TO_BIN(?) AND i.provider='github'
       AND i.disconnected_at IS NULL AND r.enabled=TRUE
     ORDER BY r.display_name`,
		[userId, teamId],
	);
	return rows;
}

export async function authorizeGitHubUser(
	userId: string,
	teamId: string,
	authorizationCode: string,
) {
	const tokens = await exchangeGitHubUserCode(authorizationCode);
	const githubUser = await getAuthenticatedGitHubUser(tokens.accessToken);
	const installationAccess = await installationsForUser(tokens.accessToken);
	const repositories = installationAccess.flatMap(
		(entry) => entry.repositories,
	);
	const connectionId = await saveUserConnection(
		userId,
		githubUser,
		primaryInstallationId(installationAccess),
		tokens,
	);
	const integrationIds = await synchronizeRepositoryAccess(
		connectionId,
		teamId,
		installationAccess,
	);
	return { connectionId, integrationIds, githubUser, repositories };
}

export async function refreshGitHubRepositoriesForUser(
	teamId: string,
	userId: string,
) {
	const connection = await activeConnection(userId);
	const token = await accessToken(connection);
	const installationAccess = await installationsForUser(token);
	await database().execute(
		`UPDATE github_user_connections SET installation_id=?,updated_at=CURRENT_TIMESTAMP(3)
     WHERE id=UUID_TO_BIN(?)`,
		[primaryInstallationId(installationAccess), connection.id],
	);
	await synchronizeRepositoryAccess(
		connection.id,
		teamId,
		installationAccess,
	);
	return visibleRepositories(teamId, userId);
}

export async function requireGitHubRepositoryAccess(
	teamId: string,
	userId: string,
	fullName: string,
) {
	const repositories = await refreshGitHubRepositoriesForUser(teamId, userId);
	const repository = repositories.find(
		(candidate) => candidate.fullName.toLowerCase() === fullName.toLowerCase(),
	);
	if (!repository)
		throw new GitHubIntegrationError(
			"repository_not_available_to_github_user",
			"Your connected GitHub account does not have access to this repository.",
		);
	return repository;
}

export function listStoredGitHubRepositoriesForUser(
	teamId: string,
	userId: string,
) {
	return visibleRepositories(teamId, userId);
}

export async function githubUserConnectionForTeam(
	teamId: string,
	userId: string,
) {
	const [rows] = await database().query<
		(RowDataPacket & {
			id: string;
			githubLogin: string;
			githubUserId: string;
			repositories: number;
			connectedAt: Date;
		})[]
	>(
		`SELECT BIN_TO_UUID(c.id) AS id,c.github_login AS githubLogin,
            c.github_user_id AS githubUserId,COUNT(i.id) AS repositories,
            c.created_at AS connectedAt
     FROM github_user_connections c
     LEFT JOIN github_user_repository_access a ON a.connection_id=c.id
     LEFT JOIN integrations i ON i.id=a.integration_id AND i.team_id=UUID_TO_BIN(?)
     WHERE c.user_id=UUID_TO_BIN(?) AND c.disconnected_at IS NULL
     GROUP BY c.id LIMIT 1`,
		[teamId, userId],
	);
	return rows[0] ?? null;
}

export async function disconnectGitHubUser(
	teamId: string,
	userId: string,
	auditUserId: string,
) {
	const connection = await database().getConnection();
	try {
		await connection.beginTransaction();
		const [rows] = await connection.query<
			(RowDataPacket & { id: string; githubLogin: string })[]
		>(
			`SELECT BIN_TO_UUID(id) AS id,github_login AS githubLogin
       FROM github_user_connections
       WHERE user_id=UUID_TO_BIN(?) AND disconnected_at IS NULL LIMIT 1 FOR UPDATE`,
			[userId],
		);
		const githubConnection = rows[0];
		if (!githubConnection)
			throw new GitHubIntegrationError(
				"github_user_connection_not_found",
				"No GitHub account is connected.",
			);
		await connection.execute(
			`DELETE FROM github_user_repository_access WHERE connection_id=UUID_TO_BIN(?)`,
			[githubConnection.id],
		);
		await connection.execute(
			`DELETE FROM github_user_installations WHERE connection_id=UUID_TO_BIN(?)`,
			[githubConnection.id],
		);
		await connection.execute(
			`UPDATE github_user_connections SET encrypted_credentials=?,token_expires_at=NULL,
         refresh_token_expires_at=NULL,disconnected_at=CURRENT_TIMESTAMP(3),
         updated_at=CURRENT_TIMESTAMP(3) WHERE id=UUID_TO_BIN(?)`,
			[encryptSecret("{}"), githubConnection.id],
		);
		await connection.execute(
			`INSERT INTO audit_events
       (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','integration.github.user_disconnected',
         'github_user_connection',?,?)`,
			[
				teamId,
				auditUserId,
				githubConnection.id,
				JSON.stringify({ githubLogin: githubConnection.githubLogin }),
			],
		);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}
