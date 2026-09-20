import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";
import { randomToken, tokenHash } from "../auth/auth.crypto.js";
import { requireSession } from "../auth/auth.guard.js";
import type { SessionUser } from "../auth/auth.types.js";
import { requireTeam, teamFrom } from "../teams/team.context.js";
import { encryptSecret } from "../../security/secrets.js";
import {
  cloudflareAuthorizationUrl,
  cloudflareUserInfo,
  cloudflareZones,
  exchangeCloudflareCode,
} from "./cloudflare-oauth.js";
import {
  getGitHubInstallation,
  githubInstallationUrl,
  listGitHubInstallationRepositories,
  verifyGitHubInstallationForUser,
} from "./github-app.js";

type OAuthStateRow = RowDataPacket & {
  id: string;
  teamId: string;
  userId: string;
  returnPath: string;
};
const connectBody = z.object({
  returnPath: z
    .string()
    .startsWith("/")
    .max(512)
    .default("/settings/integrations"),
});
const callbackQuery = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(20),
  error: z.string().optional(),
});
const githubSetupQuery = z.object({
  installation_id: z.coerce.number().int().positive(),
  code: z.string().min(1),
  state: z.string().min(20),
});
const integrationParams = z.object({ integrationId: z.string().uuid() });

function userFrom(request: FastifyRequest) {
  return (request as FastifyRequest & { sessionUser: SessionUser }).sessionUser;
}

function canManageIntegrations(role: string) {
  return role === "owner" || role === "administrator";
}

function canRefreshRepositories(role: string) {
  return (
    role === "owner" || role === "administrator" || role === "developer"
  );
}

async function githubRepositoriesForTeam(teamId: string) {
  const [repositories] = await database().query<
    (RowDataPacket & {
      id: string;
      integrationId: string;
      repositoryId: string;
      fullName: string;
      metadata: string | Record<string, unknown> | null;
    })[]
  >(
    `SELECT BIN_TO_UUID(r.id) AS id,BIN_TO_UUID(i.id) AS integrationId,r.external_resource_id AS repositoryId,
            r.display_name AS fullName,r.metadata
     FROM integration_resources r JOIN integrations i ON i.id=r.integration_id
     WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='github' AND i.disconnected_at IS NULL
       AND r.resource_type='repository' AND r.enabled=TRUE ORDER BY r.display_name`,
    [teamId],
  );
  return repositories;
}

async function refreshGitHubRepositories(teamId: string) {
  const [integrations] = await database().query<
    (RowDataPacket & { id: string; installationId: string })[]
  >(
    `SELECT BIN_TO_UUID(id) AS id,external_account_id AS installationId
     FROM integrations
     WHERE team_id=UUID_TO_BIN(?) AND provider='github' AND disconnected_at IS NULL
     ORDER BY created_at`,
    [teamId],
  );

  for (const integration of integrations) {
    const installationId = Number(integration.installationId);
    if (!Number.isSafeInteger(installationId) || installationId < 1)
      throw new Error("Invalid GitHub installation id");
    const repositories =
      await listGitHubInstallationRepositories(installationId);
    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE integration_resources SET enabled=FALSE
         WHERE integration_id=UUID_TO_BIN(?) AND resource_type='repository'`,
        [integration.id],
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
            integration.id,
            String(repository.id),
            repository.full_name,
            JSON.stringify({
              private: repository.private,
              defaultBranch: repository.default_branch,
              htmlUrl: repository.html_url,
            }),
          ],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function disconnectIntegration(
  integrationId: string,
  provider: "github" | "cloudflare",
  teamId: string,
  userId: string,
) {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE integrations SET disconnected_at=CURRENT_TIMESTAMP(3),
         encrypted_credentials=?,token_expires_at=NULL,updated_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND provider=?
         AND disconnected_at IS NULL`,
      [encryptSecret("{}"), integrationId, teamId, provider],
    );
    if (!result.affectedRows) throw new Error("integration_not_found");
    await connection.execute(
      "UPDATE integration_resources SET enabled=FALSE WHERE integration_id=UUID_TO_BIN(?)",
      [integrationId],
    );
    await connection.execute(
      `INSERT INTO audit_events
       (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel',?,'integration',?,?)`,
      [
        teamId,
        userId,
        `integration.${provider}.disconnected`,
        integrationId,
        JSON.stringify({ provider }),
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

export const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/github",
    { preHandler: [requireSession, requireTeam] },
    async (request) => {
      const team = teamFrom(request);
      const [connections] = await database().query<
        (RowDataPacket & {
          id: string;
          installationId: string;
          displayName: string;
          accountType: string | null;
          repositories: number;
          createdAt: Date;
        })[]
      >(
        `SELECT BIN_TO_UUID(i.id) AS id,i.external_account_id AS installationId,i.display_name AS displayName,
              JSON_UNQUOTE(JSON_EXTRACT(i.metadata,'$.accountType')) AS accountType,
              COUNT(r.id) AS repositories,i.created_at AS createdAt
       FROM integrations i LEFT JOIN integration_resources r ON r.integration_id=i.id AND r.resource_type='repository'
       WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='github' AND i.disconnected_at IS NULL
       GROUP BY i.id ORDER BY i.created_at`,
        [team.id],
      );
      return { data: connections, meta: { team } };
    },
  );

  app.delete(
    "/github/:integrationId",
    { preHandler: [requireSession, requireTeam] },
    async (request, reply) => {
      const params = integrationParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canManageIntegrations(team.role))
        return reply.status(403).send({ error: "team_admin_required" });
      try {
        await disconnectIntegration(
          params.data.integrationId,
          "github",
          team.id,
          userFrom(request).id,
        );
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof Error && error.message === "integration_not_found")
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get(
    "/github/repositories",
    { preHandler: [requireSession, requireTeam] },
    async (request) => {
      const team = teamFrom(request);
      return { data: await githubRepositoriesForTeam(team.id), meta: { team } };
    },
  );

  app.post(
    "/github/repositories/refresh",
    { preHandler: [requireSession, requireTeam] },
    async (request, reply) => {
      const team = teamFrom(request);
      if (!canRefreshRepositories(team.role))
        return reply.status(403).send({ error: "team_write_required" });
      try {
        await refreshGitHubRepositories(team.id);
        reply.header("Cache-Control", "no-store");
        return {
          data: await githubRepositoriesForTeam(team.id),
          meta: { team, refreshed: true },
        };
      } catch (error) {
        request.log.error(
          { err: error, teamId: team.id },
          "GitHub repository refresh failed",
        );
        return reply
          .status(502)
          .send({
            error: "github_repository_refresh_failed",
            message: "Could not refresh repositories from GitHub",
          });
      }
    },
  );

  app.post(
    "/github/connect",
    { preHandler: [requireSession, requireTeam] },
    async (request, reply) => {
      const body = connectBody.safeParse(request.body ?? {});
      if (!body.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canManageIntegrations(team.role))
        return reply.status(403).send({ error: "team_admin_required" });
      const state = randomToken(32);
      await database().execute(
        `INSERT INTO oauth_authorization_states (id,team_id,user_id,provider,state_hash,return_path,expires_at)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'github',?,?,CURRENT_TIMESTAMP(3)+INTERVAL 10 MINUTE)`,
        [
          randomUUID(),
          team.id,
          userFrom(request).id,
          tokenHash(state),
          body.data.returnPath,
        ],
      );
      return { data: { installationUrl: githubInstallationUrl(state) } };
    },
  );

  app.get("/github/callback", async (request, reply) => {
    const query = githubSetupQuery.safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({ error: "invalid_github_setup" });
    const [states] = await database().query<OAuthStateRow[]>(
      `SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(team_id) AS teamId,BIN_TO_UUID(user_id) AS userId,return_path AS returnPath
       FROM oauth_authorization_states WHERE state_hash=? AND provider='github'
         AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
      [tokenHash(query.data.state)],
    );
    const state = states[0];
    if (!state)
      return reply
        .status(400)
        .send({ error: "invalid_or_expired_oauth_state" });
    const [consumed] = await database().execute<ResultSetHeader>(
      `UPDATE oauth_authorization_states SET consumed_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?) AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3)`,
      [state.id],
    );
    if (!consumed.affectedRows)
      return reply.status(400).send({ error: "invalid_or_expired_oauth_state" });
    const redirect = new URL(state.returnPath, env.PANEL_ORIGIN);

    try {
      await verifyGitHubInstallationForUser(
        query.data.installation_id,
        query.data.code,
      );
      const installation = await getGitHubInstallation(
        query.data.installation_id,
      );
      if (installation.suspended_at)
        throw new Error("GitHub App installation is suspended");
      const repositories = await listGitHubInstallationRepositories(
        installation.id,
      );
      const installationId = String(installation.id);
      const [existing] = await database().query<
        (RowDataPacket & { id: string })[]
      >(
        `SELECT BIN_TO_UUID(id) AS id FROM integrations
         WHERE team_id=UUID_TO_BIN(?) AND provider='github' AND external_account_id=? LIMIT 1`,
        [state.teamId, installationId],
      );
      const integrationId = existing[0]?.id ?? randomUUID();
      const connection = await database().getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO integrations
           (id,team_id,provider,auth_method,connection_scope,external_account_id,display_name,encrypted_credentials,metadata,disconnected_at)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'github','oauth','customer',?,?,?,?,NULL)
           ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),encrypted_credentials=VALUES(encrypted_credentials),
             metadata=VALUES(metadata),disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP(3)`,
          [
            integrationId,
            state.teamId,
            installationId,
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
        await connection.execute(
          "DELETE FROM integration_resources WHERE integration_id=UUID_TO_BIN(?)",
          [integrationId],
        );
        await connection.execute(
          `INSERT INTO integration_resources (id,integration_id,resource_type,external_resource_id,display_name,metadata)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'account',?,?,?)`,
          [
            randomUUID(),
            integrationId,
            String(installation.account.id),
            installation.account.login,
            JSON.stringify({
              type: installation.account.type,
              avatarUrl: installation.account.avatar_url ?? null,
            }),
          ],
        );
        for (const repository of repositories) {
          await connection.execute(
            `INSERT INTO integration_resources (id,integration_id,resource_type,external_resource_id,display_name,metadata)
             VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'repository',?,?,?)`,
            [
              randomUUID(),
              integrationId,
              String(repository.id),
              repository.full_name,
              JSON.stringify({
                private: repository.private,
                defaultBranch: repository.default_branch,
                htmlUrl: repository.html_url,
              }),
            ],
          );
        }
        await connection.execute(
          `INSERT INTO audit_events (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','integration.github.connected','integration',?,?)`,
          [
            state.teamId,
            state.userId,
            integrationId,
            JSON.stringify({
              installationId,
              repositories: repositories.length,
            }),
          ],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      redirect.searchParams.set("integration", "github_connected");
      return reply.redirect(redirect.toString());
    } catch (error) {
      request.log.error(error);
      redirect.searchParams.set("integration", "github_failed");
      return reply.redirect(redirect.toString());
    }
  });

  app.get(
    "/cloudflare",
    { preHandler: [requireSession, requireTeam] },
    async (request) => {
      const team = teamFrom(request);
      const [connections] = await database().query<
        (RowDataPacket & {
          id: string;
          displayName: string;
          scope: string | null;
          tokenExpiresAt: Date | null;
          createdAt: Date;
          zones: number;
        })[]
      >(
        `SELECT BIN_TO_UUID(i.id) AS id,i.display_name AS displayName,
              JSON_UNQUOTE(JSON_EXTRACT(i.metadata,'$.scope')) AS scope,
              i.token_expires_at AS tokenExpiresAt,i.created_at AS createdAt,
              COUNT(r.id) AS zones
       FROM integrations i LEFT JOIN integration_resources r ON r.integration_id=i.id AND r.resource_type='zone'
       WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='cloudflare' AND i.disconnected_at IS NULL
       GROUP BY i.id ORDER BY i.created_at`,
        [team.id],
      );
      return { data: connections, meta: { team } };
    },
  );

  app.delete(
    "/cloudflare/:integrationId",
    { preHandler: [requireSession, requireTeam] },
    async (request, reply) => {
      const params = integrationParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canManageIntegrations(team.role))
        return reply.status(403).send({ error: "team_admin_required" });
      try {
        await disconnectIntegration(
          params.data.integrationId,
          "cloudflare",
          team.id,
          userFrom(request).id,
        );
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof Error && error.message === "integration_not_found")
          return reply.status(404).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get(
    "/cloudflare/zones",
    { preHandler: [requireSession, requireTeam] },
    async (request) => {
      const team = teamFrom(request);
      const [zones] = await database().query<
        (RowDataPacket & {
          id: string;
          integrationId: string;
          zoneId: string;
          name: string;
        })[]
      >(
        `SELECT BIN_TO_UUID(r.id) AS id,BIN_TO_UUID(i.id) AS integrationId,
              r.external_resource_id AS zoneId,r.display_name AS name
       FROM integration_resources r JOIN integrations i ON i.id=r.integration_id
       WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='cloudflare' AND i.disconnected_at IS NULL
         AND r.resource_type='zone' AND r.enabled=TRUE ORDER BY r.display_name`,
        [team.id],
      );
      return { data: zones, meta: { team } };
    },
  );

  app.post(
    "/cloudflare/connect",
    { preHandler: [requireSession, requireTeam] },
    async (request, reply) => {
      const body = connectBody.safeParse(request.body ?? {});
      if (!body.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      if (!canManageIntegrations(team.role))
        return reply.status(403).send({ error: "team_admin_required" });
      const user = userFrom(request);
      const state = randomToken(32);
      await database().execute(
        `INSERT INTO oauth_authorization_states (id,team_id,user_id,provider,state_hash,return_path,expires_at)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'cloudflare',?,?,CURRENT_TIMESTAMP(3)+INTERVAL 10 MINUTE)`,
        [
          randomUUID(),
          team.id,
          user.id,
          tokenHash(state),
          body.data.returnPath,
        ],
      );
      return { data: { authorizationUrl: cloudflareAuthorizationUrl(state) } };
    },
  );

  app.get("/cloudflare/callback", async (request, reply) => {
    const query = callbackQuery.safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({ error: "invalid_oauth_callback" });

    const [states] = await database().query<OAuthStateRow[]>(
      `SELECT BIN_TO_UUID(id) AS id,BIN_TO_UUID(team_id) AS teamId,BIN_TO_UUID(user_id) AS userId,return_path AS returnPath
       FROM oauth_authorization_states WHERE state_hash=? AND provider='cloudflare'
         AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
      [tokenHash(query.data.state)],
    );
    const state = states[0];
    if (!state)
      return reply
        .status(400)
        .send({ error: "invalid_or_expired_oauth_state" });
    const [consumed] = await database().execute<ResultSetHeader>(
      `UPDATE oauth_authorization_states SET consumed_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?) AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3)`,
      [state.id],
    );
    if (!consumed.affectedRows)
      return reply.status(400).send({ error: "invalid_or_expired_oauth_state" });

    const redirect = new URL(state.returnPath, env.PANEL_ORIGIN);
    if (query.data.error || !query.data.code) {
      redirect.searchParams.set("integration", "cloudflare_denied");
      return reply.redirect(redirect.toString());
    }

    try {
      const tokens = await exchangeCloudflareCode(query.data.code);
      const [profile, zones] = await Promise.all([
        cloudflareUserInfo(tokens.access_token),
        cloudflareZones(tokens.access_token),
      ]);
      const externalId = profile.sub || profile.id || profile.email;
      if (!externalId)
        throw new Error("Cloudflare did not return an account identity");
      const displayName = profile.name || profile.email || "Cloudflare account";
      const tokenExpiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;
      const credentials = encryptSecret(JSON.stringify(tokens));
      const [existing] = await database().query<
        (RowDataPacket & { id: string })[]
      >(
        `SELECT BIN_TO_UUID(id) AS id FROM integrations
         WHERE team_id=UUID_TO_BIN(?) AND provider='cloudflare' AND external_account_id=? LIMIT 1`,
        [state.teamId, externalId],
      );
      const integrationId = existing[0]?.id ?? randomUUID();
      const connection = await database().getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO integrations
           (id,team_id,provider,auth_method,connection_scope,external_account_id,display_name,encrypted_credentials,token_expires_at,metadata,disconnected_at)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'cloudflare','oauth','customer',?,?,?,?,?,NULL)
           ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),encrypted_credentials=VALUES(encrypted_credentials),
             token_expires_at=VALUES(token_expires_at),metadata=VALUES(metadata),disconnected_at=NULL,updated_at=CURRENT_TIMESTAMP(3)`,
          [
            integrationId,
            state.teamId,
            externalId,
            displayName,
            credentials,
            tokenExpiresAt,
            JSON.stringify({
              scope: tokens.scope ?? env.CLOUDFLARE_OAUTH_SCOPES,
              email: profile.email ?? null,
            }),
          ],
        );
        await connection.execute(
          "DELETE FROM integration_resources WHERE integration_id=UUID_TO_BIN(?)",
          [integrationId],
        );

        const accounts = new Map<string, string>();
        for (const zone of zones) {
          if (zone.account?.id)
            accounts.set(zone.account.id, zone.account.name);
          await connection.execute(
            `INSERT INTO integration_resources (id,integration_id,resource_type,external_resource_id,display_name,metadata)
             VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'zone',?,?,?)`,
            [
              randomUUID(),
              integrationId,
              zone.id,
              zone.name,
              JSON.stringify({
                status: zone.status ?? null,
                accountId: zone.account?.id ?? null,
              }),
            ],
          );
        }
        for (const [accountId, accountName] of accounts) {
          await connection.execute(
            `INSERT INTO integration_resources (id,integration_id,resource_type,external_resource_id,display_name)
             VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'account',?,?)`,
            [randomUUID(), integrationId, accountId, accountName],
          );
        }
        await connection.execute(
          `INSERT INTO audit_events (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','integration.cloudflare.connected','integration',?,?)`,
          [
            state.teamId,
            state.userId,
            integrationId,
            JSON.stringify({ zones: zones.length }),
          ],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      redirect.searchParams.set("integration", "cloudflare_connected");
      return reply.redirect(redirect.toString());
    } catch (error) {
      request.log.error(error);
      redirect.searchParams.set("integration", "cloudflare_failed");
      return reply.redirect(redirect.toString());
    }
  });
};
