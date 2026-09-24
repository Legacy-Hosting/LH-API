import { createSign } from "node:crypto";
import { env } from "../../../core/config/env.js";

type GitHubInstallation = {
	id: number;
	account: { id: number; login: string; type: string; avatar_url?: string };
	repository_selection: "all" | "selected";
	permissions: Record<string, string>;
	suspended_at: string | null;
};

export type GitHubRepository = {
	id: number;
	name: string;
	full_name: string;
	private: boolean;
	default_branch: string;
	html_url: string;
	owner: { login: string };
	permissions?: Record<string, boolean>;
};

export type GitHubOrganizationMembership = {
	state: string;
	organization: { login: string };
};

export type GitHubUserTokens = {
	accessToken: string;
	expiresIn: number | null;
	refreshToken: string | null;
	refreshTokenExpiresIn: number | null;
};

export class GitHubApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly ssoHeader: string | null = null,
	) {
		super(message);
		this.name = "GitHubApiError";
	}
}

function appConfiguration() {
	if (
		!env.GITHUB_APP_ID ||
		!env.GITHUB_CLIENT_ID ||
		!env.GITHUB_CLIENT_SECRET ||
		!env.GITHUB_APP_PRIVATE_KEY_BASE64
	) {
		throw new Error("GitHub App is not configured");
	}
	return {
		appId: env.GITHUB_APP_ID,
		clientId: env.GITHUB_CLIENT_ID,
		clientSecret: env.GITHUB_CLIENT_SECRET,
		privateKey: Buffer.from(
			env.GITHUB_APP_PRIVATE_KEY_BASE64,
			"base64",
		).toString("utf8"),
	};
}

function oauthConfiguration() {
	if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
		throw new Error("GitHub App OAuth is not configured");
	return {
		clientId: env.GITHUB_CLIENT_ID,
		clientSecret: env.GITHUB_CLIENT_SECRET,
		redirectUri: env.GITHUB_OAUTH_REDIRECT_URI,
	};
}

function encode(value: object) {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function githubAppJwt() {
	const config = appConfiguration();
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 9 * 60, iss: config.appId })}`;
	const signer = createSign("RSA-SHA256");
	signer.update(unsigned);
	signer.end();
	return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
}

async function githubRequest<T>(
	path: string,
	token: string,
	init: RequestInit = {},
) {
	const response = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": env.GITHUB_API_VERSION,
			"User-Agent": "Legacy-Hosting-Panel",
			...init.headers,
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) {
		const raw = await response.text();
		let message = raw;
		try {
			const payload = JSON.parse(raw) as { message?: string };
			message = payload.message || raw;
		} catch {
			// GitHub can return a plain-text failure from edge services.
		}
		throw new GitHubApiError(
			response.status,
			`GitHub API ${response.status}: ${message.slice(0, 300)}`,
			response.headers.get("x-github-sso"),
		);
	}
	return response.status === 204
		? (undefined as T)
		: (response.json() as Promise<T>);
}

export function githubUserAuthorizationUrl(state: string) {
	const config = oauthConfiguration();
	const url = new URL("https://github.com/login/oauth/authorize");
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("state", state);
	if (config.redirectUri)
		url.searchParams.set("redirect_uri", config.redirectUri);
	return url.toString();
}

export function getGitHubOrganizationInstallation(organization: string) {
	return githubRequest<GitHubInstallation>(
		`/orgs/${encodeURIComponent(organization)}/installation`,
		githubAppJwt(),
	);
}

export function getGitHubInstallation(installationId: number) {
	return githubRequest<GitHubInstallation>(
		`/app/installations/${installationId}`,
		githubAppJwt(),
	);
}

export async function createGitHubInstallationToken(
	installationId: number,
	repositoryIds?: number[],
) {
	return githubRequest<{ token: string; expires_at: string }>(
		`/app/installations/${installationId}/access_tokens`,
		githubAppJwt(),
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				repositoryIds?.length ? { repository_ids: repositoryIds } : {},
			),
		},
	);
}

export async function listGitHubInstallationRepositories(
	installationId: number,
) {
	const access = await createGitHubInstallationToken(installationId);
	const repositories: GitHubRepository[] = [];
	for (let page = 1; page <= 100; page += 1) {
		const response = await githubRequest<{
			total_count: number;
			repositories: GitHubRepository[];
		}>(`/installation/repositories?per_page=100&page=${page}`, access.token);
		repositories.push(...response.repositories);
		if (
			repositories.length >= response.total_count ||
			response.repositories.length < 100
		)
			break;
	}
	return repositories;
}

export async function githubInstallationRequest<T>(
	installationId: number,
	path: string,
	repositoryIds?: number[],
) {
	const access = await createGitHubInstallationToken(
		installationId,
		repositoryIds,
	);
	return githubRequest<T>(path, access.token);
}

async function githubUserTokenRequest(body: Record<string, string>) {
	const config = oauthConfiguration();
	const tokenResponse = await fetch(
		"https://github.com/login/oauth/access_token",
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "Legacy-Hosting-Panel",
			},
			body: JSON.stringify({
				client_id: config.clientId,
				client_secret: config.clientSecret,
				...body,
				...(config.redirectUri ? { redirect_uri: config.redirectUri } : {}),
			}),
			signal: AbortSignal.timeout(20_000),
		},
	);
	const token = (await tokenResponse.json()) as {
		access_token?: string;
		expires_in?: number;
		refresh_token?: string;
		refresh_token_expires_in?: number;
		error?: string;
		error_description?: string;
	};
	if (!tokenResponse.ok || !token.access_token) {
		throw new GitHubApiError(
			tokenResponse.status,
			token.error_description || token.error || "GitHub authorization failed",
		);
	}
	return {
		accessToken: token.access_token,
		expiresIn: token.expires_in ?? null,
		refreshToken: token.refresh_token ?? null,
		refreshTokenExpiresIn: token.refresh_token_expires_in ?? null,
	} satisfies GitHubUserTokens;
}

export function exchangeGitHubUserCode(authorizationCode: string) {
	return githubUserTokenRequest({
		grant_type: "authorization_code",
		code: authorizationCode,
	});
}

export function refreshGitHubUserToken(refreshToken: string) {
	return githubUserTokenRequest({
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
}

export function getAuthenticatedGitHubUser(accessToken: string) {
	return githubRequest<{
		id: number;
		login: string;
		avatar_url?: string;
	}>("/user", accessToken);
}

export async function listGitHubUserOrganizations(accessToken: string) {
	const memberships: GitHubOrganizationMembership[] = [];
	for (let page = 1; page <= 100; page += 1) {
		const response = await githubRequest<GitHubOrganizationMembership[]>(
			`/user/memberships/orgs?state=active&per_page=100&page=${page}`,
			accessToken,
		);
		memberships.push(...response);
		if (response.length < 100) break;
	}
	return memberships;
}

export function hasActiveGitHubOrganizationMembership(
	memberships: GitHubOrganizationMembership[],
	organization: string,
) {
	return memberships.some(
		(membership) =>
			membership.state === "active" &&
			membership.organization.login.toLowerCase() ===
				organization.toLowerCase(),
	);
}

export function githubRepositoriesForOrganization(
	repositories: GitHubRepository[],
	organization: string,
) {
	return repositories.filter(
		(repository) =>
			repository.owner.login.toLowerCase() === organization.toLowerCase(),
	);
}

export async function listGitHubUserInstallationRepositories(
	installationId: number,
	accessToken: string,
) {
	const repositories: GitHubRepository[] = [];
	for (let page = 1; page <= 100; page += 1) {
		const response = await githubRequest<{
			total_count: number;
			repositories: GitHubRepository[];
		}>(
			`/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
			accessToken,
		);
		repositories.push(...response.repositories);
		if (
			repositories.length >= response.total_count ||
			response.repositories.length < 100
		)
			break;
	}
	return repositories;
}

export function githubAuthorizationErrorCode(error: unknown) {
	if (
		error instanceof GitHubApiError &&
		error.status === 403 &&
		(error.ssoHeader?.toLowerCase().includes("required") ||
			/\b(?:saml|sso)\b/i.test(error.message))
	)
		return "github_sso_required";
	if (error instanceof GitHubApiError && error.status === 401)
		return "github_reauthorization_required";
	return null;
}
