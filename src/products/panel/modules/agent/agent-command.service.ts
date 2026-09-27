import {
  randomToken,
  tokenHash,
} from "../../../../shared/modules/auth/auth.crypto.js";
import { database } from "../../../../core/database/mysql.js";
import { decryptSecret } from "../../../../shared/security/secrets.js";
import { createGitHubInstallationToken } from "../../../../shared/modules/integrations/github-app.js";
import {
  cloudflareAccessForZone,
  removeCloudflareRecord,
} from "../../../../shared/modules/integrations/cloudflare-api.js";
import { env } from "../../../../core/config/env.js";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";

type CommandType =
  | "deploy"
  | "start"
  | "stop"
  | "restart"
  | "delete"
  | "configure_proxy"
  | "renew_certificate"
  | "logs"
  | "write_persistent_file";

type CommandRow = RowDataPacket & {
  id: string;
  commandType: CommandType;
  payload: string | Record<string, unknown>;
  applicationId: string | null;
  teamId: string | null;
  storagePath: string | null;
  processName: string | null;
  internalPort: number | null;
  repository: string | null;
  branch: string | null;
  runtime: string | Record<string, unknown> | null;
  hostname: string | null;
  rootDomain: string | null;
};

type ProcessRow = RowDataPacket & {
  id: string;
  name: string;
  processName: string;
  type: "web" | "api" | "bot" | "worker" | "custom";
  workingDirectory: string;
  executable: string;
  arguments: string | string[];
  internalPort: number | null;
  primary: number;
  public: number;
  routes: string | string[];
  enabled: number;
  startOrder: number;
  instances: number;
  restartDelayMs: number;
  inheritEnvironment: number;
  healthPath: string | null;
  hostVariable: string | null;
  portVariable: string | null;
  hostname: string | null;
  rootDomain: string | null;
};

function json<T>(value: string | T | null): T | null {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function previousApplicationStatus(payload: Record<string, unknown>) {
  const status = payload.previousApplicationStatus;
  return typeof status === "string" &&
    ["pending", "running", "stopped", "failed"].includes(status)
    ? status
    : "failed";
}

export async function appendAgentCommandOutput(
  nodeId: string,
  input: { commandId: string; leaseToken: string; chunk: string },
) {
  await database().execute(
    `UPDATE node_commands SET output=RIGHT(CONCAT(COALESCE(output,''),?),200000),
       lease_expires_at=CURRENT_TIMESTAMP(3)+INTERVAL 5 MINUTE
     WHERE id=UUID_TO_BIN(?) AND node_id=UUID_TO_BIN(?) AND status='leased'
       AND lease_token_hash=? AND lease_expires_at>CURRENT_TIMESTAMP(3)`,
    [
      input.chunk,
      input.commandId,
      nodeId,
      tokenHash(input.leaseToken),
    ],
  );
  const [commands] = await database().query<
    (RowDataPacket & { cancelRequested: number })[]
  >(
    `SELECT cancel_requested_at IS NOT NULL AS cancelRequested FROM node_commands
     WHERE id=UUID_TO_BIN(?) AND node_id=UUID_TO_BIN(?) AND status='leased'
       AND lease_token_hash=? AND lease_expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
    [input.commandId, nodeId, tokenHash(input.leaseToken)],
  );
  if (!commands[0]) throw new Error("invalid_or_expired_command_lease");
  return { cancelRequested: Boolean(commands[0]?.cancelRequested) };
}

export async function claimAgentCommand(nodeId: string) {
  const [nodes] = await database().query<
    (RowDataPacket & { agentMode: string })[]
  >(
    "SELECT agent_mode AS agentMode FROM nodes WHERE id=UUID_TO_BIN(?) LIMIT 1",
    [nodeId],
  );
  if (nodes[0]?.agentMode !== "hosting-node") return null;

  const connection = await database().getConnection();
  let command: CommandRow | undefined;
  let leaseToken = "";
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO notifications
       (id,team_id,notification_type,severity,title,message,resource_type,resource_id)
       SELECT UUID_TO_BIN(UUID()),a.team_id,'deployment_cancelled','info',
              CONCAT(a.name,' deployment cancelled'),
              'The deployment cancellation completed after its node lease expired.',
              'deployment',BIN_TO_UUID(c.deployment_id)
       FROM node_commands c JOIN applications a ON a.id=c.application_id
       WHERE c.node_id=UUID_TO_BIN(?) AND c.status='leased'
         AND c.lease_expires_at<CURRENT_TIMESTAMP(3) AND c.cancel_requested_at IS NOT NULL
         AND c.deployment_id IS NOT NULL`,
      [nodeId],
    );
    await connection.execute(
      `UPDATE applications a JOIN node_commands c ON c.application_id=a.id
       SET a.status=CASE JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.previousApplicationStatus'))
         WHEN 'pending' THEN 'pending' WHEN 'running' THEN 'running'
         WHEN 'stopped' THEN 'stopped' WHEN 'failed' THEN 'failed' ELSE 'failed' END
       WHERE c.node_id=UUID_TO_BIN(?) AND c.status='leased'
         AND c.lease_expires_at<CURRENT_TIMESTAMP(3) AND c.cancel_requested_at IS NOT NULL`,
      [nodeId],
    );
    await connection.execute(
      `UPDATE deployments d JOIN node_commands c ON c.deployment_id=d.id
       SET d.status='cancelled',d.finished_at=CURRENT_TIMESTAMP(3)
       WHERE c.node_id=UUID_TO_BIN(?) AND c.status='leased'
         AND c.lease_expires_at<CURRENT_TIMESTAMP(3) AND c.cancel_requested_at IS NOT NULL`,
      [nodeId],
    );
    await connection.execute(
      `UPDATE node_commands SET status='cancelled',lease_token_hash=NULL,lease_expires_at=NULL,
         finished_at=CURRENT_TIMESTAMP(3),output=CONCAT(COALESCE(output,''),'\nCancellation completed after lease expiry')
       WHERE node_id=UUID_TO_BIN(?) AND status='leased' AND lease_expires_at<CURRENT_TIMESTAMP(3)
         AND cancel_requested_at IS NOT NULL`,
      [nodeId],
    );
    await connection.execute(
      `UPDATE node_commands SET status=IF(attempts>=3,'failed','queued'),lease_token_hash=NULL,lease_expires_at=NULL,
         finished_at=IF(attempts>=3,CURRENT_TIMESTAMP(3),finished_at),output=IF(attempts>=3,'Command lease expired too many times',output)
       WHERE node_id=UUID_TO_BIN(?) AND status='leased' AND lease_expires_at<CURRENT_TIMESTAMP(3)
         AND cancel_requested_at IS NULL`,
      [nodeId],
    );
    const [rows] = await connection.query<CommandRow[]>(
      `SELECT BIN_TO_UUID(c.id) AS id,c.command_type AS commandType,c.payload,
              BIN_TO_UUID(c.application_id) AS applicationId,BIN_TO_UUID(a.team_id) AS teamId,
              a.storage_path AS storagePath,a.pm2_process_name AS processName,
              COALESCE(p.internal_port,a.internal_port) AS internalPort,
              a.repository_full_name AS repository,a.repository_branch AS branch,a.detected_runtime AS runtime,
              d.hostname,d.root_domain AS rootDomain
       FROM node_commands c LEFT JOIN applications a ON a.id=c.application_id
       LEFT JOIN application_processes p
         ON p.id=UUID_TO_BIN(JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.processId')))
       LEFT JOIN domains d ON d.id=COALESCE(
         UUID_TO_BIN(JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.domainId'))),p.domain_id,a.domain_id
       )
       WHERE c.node_id=UUID_TO_BIN(?) AND c.status='queued' AND c.attempts<3
       ORDER BY c.created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [nodeId],
    );
    command = rows[0];
    if (command) {
      leaseToken = randomToken(32);
      await connection.execute(
        `UPDATE node_commands SET status='leased',lease_token_hash=?,lease_expires_at=CURRENT_TIMESTAMP(3)+INTERVAL 30 MINUTE,
           attempts=attempts+1,started_at=COALESCE(started_at,CURRENT_TIMESTAMP(3)) WHERE id=UUID_TO_BIN(?)`,
        [tokenHash(leaseToken), command.id],
      );
      const payload = json<{ deploymentId?: string }>(command.payload);
      if (command.commandType === "deploy" && payload?.deploymentId) {
        await connection.execute(
          `UPDATE deployments SET status='building',started_at=COALESCE(started_at,CURRENT_TIMESTAMP(3))
           WHERE id=UUID_TO_BIN(?) AND status='queued'`,
          [payload.deploymentId],
        );
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  if (!command) return null;

  let processes: ProcessRow[] = [];
  let cleanupProcessNames: string[] = [];
  let persistentPaths: { path: string; type: "file" | "directory" }[] = [];
  let hostnames: string[] = [];
  let proxies: Array<{
    hostname: string;
    routes: Array<{ prefix: string; port: number; processName: string }>;
  }> = [];
  if (command.applicationId) {
    const [rows] = await database().query<ProcessRow[]>(
      `SELECT BIN_TO_UUID(p.id) AS id,p.name,p.pm2_process_name AS processName,
              p.process_type AS type,p.working_directory AS workingDirectory,
              p.executable,p.arguments,p.internal_port AS internalPort,
              p.is_primary AS \`primary\`,p.is_public AS \`public\`,p.routes,p.enabled,
              p.start_order AS startOrder,p.instances,p.restart_delay_ms AS restartDelayMs,
              p.inherit_environment AS inheritEnvironment,p.health_path AS healthPath,
              p.host_variable AS hostVariable,p.port_variable AS portVariable,
              d.hostname,d.root_domain AS rootDomain
       FROM application_processes p LEFT JOIN domains d ON d.id=p.domain_id
       WHERE p.application_id=UUID_TO_BIN(?) ORDER BY p.is_primary DESC,p.created_at`,
      [command.applicationId],
    );
    processes = rows;
    const [cleanupRows] = await database().query<
      (RowDataPacket & { processName: string })[]
    >(
      `SELECT pm2_process_name AS processName FROM application_process_cleanup
       WHERE application_id=UUID_TO_BIN(?) ORDER BY created_at`,
      [command.applicationId],
    );
    cleanupProcessNames = cleanupRows.map((row) => row.processName);
    const [paths] = await database().query<
      (RowDataPacket & {
        path: string;
        type: "file" | "directory";
      })[]
    >(
      `SELECT relative_path AS path,path_type AS type
       FROM application_persistent_paths WHERE application_id=UUID_TO_BIN(?)
       ORDER BY relative_path`,
      [command.applicationId],
    );
    persistentPaths = paths;
    const [domainRows] = await database().query<
      (RowDataPacket & {
        hostname: string;
        routingMode: "shared" | "dedicated";
      })[]
    >(
      `SELECT d.hostname,ad.routing_mode AS routingMode FROM application_domains ad
       JOIN domains d ON d.id=ad.domain_id
       WHERE ad.application_id=UUID_TO_BIN(?) ORDER BY ad.is_primary DESC,d.hostname`,
      [command.applicationId],
    );
    hostnames = domainRows.map((domain) => domain.hostname);
    proxies = domainRows.map((domain) => ({
        hostname: domain.hostname,
        routes: processes
          .filter(
            (process) =>
              process.public &&
              process.enabled &&
              process.internalPort &&
              (domain.routingMode === "shared"
                ? process.hostname === command.hostname
                : process.hostname === domain.hostname),
          )
          .flatMap((process) =>
            (json<string[]>(process.routes) ?? []).map((prefix) => ({
              prefix,
              port: Number(process.internalPort),
              processName: process.name,
            })),
          ),
      }));
  }

  const environment: Record<string, string> = {};
  const generatedEnvironment: Record<string, string> = {};
  const processEnvironment = new Map<string, Record<string, string>>();
  const needsEnvironment = [
    "deploy",
    "start",
    "restart",
    "write_persistent_file",
  ].includes(command.commandType);
  if (command.applicationId && needsEnvironment) {
    const [variables] = await database().query<
      (RowDataPacket & {
        processName: string;
        variableKey: string;
        encryptedValue: Buffer;
      })[]
    >(
      `SELECT process_name AS processName,variable_key AS variableKey,encrypted_value AS encryptedValue
       FROM application_environment_variables WHERE application_id=UUID_TO_BIN(?) AND environment='production'`,
      [command.applicationId],
    );
    for (const variable of variables) {
      const value = decryptSecret(variable.encryptedValue);
      if (variable.processName === "*") {
        environment[variable.variableKey] = value;
      } else {
        const scoped = processEnvironment.get(variable.processName) ?? {};
        scoped[variable.variableKey] = value;
        processEnvironment.set(variable.processName, scoped);
      }
    }
  }
  if (needsEnvironment) {
    for (const process of processes) {
      if (!process.internalPort) continue;
      const key = process.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      generatedEnvironment[`LH_PROCESS_${key}_HOST`] = "127.0.0.1";
      generatedEnvironment[`LH_PROCESS_${key}_PORT`] = String(
        process.internalPort,
      );
      if (process.hostVariable)
        generatedEnvironment[process.hostVariable] = "127.0.0.1";
      if (process.portVariable)
        generatedEnvironment[process.portVariable] = String(
          process.internalPort,
        );
    }
  }

  let github: { token: string; expiresAt: string } | null = null;
  if (
    command.commandType === "deploy" &&
    command.repository &&
    command.teamId
  ) {
    const [repositories] = await database().query<
      (RowDataPacket & { installationId: string; repositoryId: string })[]
    >(
      `SELECT i.external_account_id AS installationId,r.external_resource_id AS repositoryId
       FROM integration_resources r JOIN integrations i ON i.id=r.integration_id
       WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='github' AND i.disconnected_at IS NULL
         AND r.resource_type='repository' AND r.display_name=? LIMIT 1`,
      [command.teamId, command.repository],
    );
    const repository = repositories[0];
    if (!repository)
      throw new Error("GitHub repository installation is unavailable");
    const access = await createGitHubInstallationToken(
      Number(repository.installationId),
      [Number(repository.repositoryId)],
    );
    github = { token: access.token, expiresAt: access.expires_at };
  }

  let tls: { cloudflareToken: string; acmeEmail: string } | null = null;
  if (
    (command.commandType === "configure_proxy" ||
      command.commandType === "renew_certificate") &&
    command.teamId &&
    command.rootDomain
  ) {
    if (!env.ACME_EMAIL) throw new Error("ACME_EMAIL is not configured");
    const access = await cloudflareAccessForZone(
      command.teamId,
      command.rootDomain,
    );
    tls = {
      cloudflareToken: access.accessToken,
      acmeEmail: env.ACME_EMAIL,
    };
  }

  const deliveredPayload =
    json<Record<string, unknown>>(command.payload) ?? {};
  if (command.commandType === "write_persistent_file") {
    const path = deliveredPayload.path;
    const encryptedContent = deliveredPayload.encryptedContent;
    if (typeof path !== "string" || typeof encryptedContent !== "string")
      throw new Error("Persistent file command payload is invalid");
    deliveredPayload.content = decryptSecret(
      Buffer.from(encryptedContent, "base64"),
    );
    delete deliveredPayload.encryptedContent;
  }

  return {
    id: command.id,
    type: command.commandType,
    leaseToken,
    payload: deliveredPayload,
    application: command.applicationId
      ? {
          id: command.applicationId,
          storagePath: command.storagePath,
          processName: command.processName,
          internalPort: command.internalPort,
          repository: command.repository,
          branch: command.branch,
          hostname: command.hostname,
          rootDomain: command.rootDomain,
          hostnames,
          runtime: json<Record<string, unknown>>(command.runtime),
          cleanupProcessNames,
          proxies,
          processes: processes.map((process) => ({
            id: process.id,
            name: process.name,
            processName: process.processName,
            type: process.type,
            workingDirectory: process.workingDirectory,
            start: {
              command: process.executable,
              args: json<string[]>(process.arguments) ?? [],
            },
            internalPort: process.internalPort,
            primary: Boolean(process.primary),
            public: Boolean(process.public),
            routes: json<string[]>(process.routes) ?? [],
            enabled: Boolean(process.enabled),
            startOrder: Number(process.startOrder),
            instances: Number(process.instances),
            restartDelayMs: Number(process.restartDelayMs),
            inheritEnvironment: Boolean(process.inheritEnvironment),
            healthPath: process.healthPath,
            hostVariable: process.hostVariable,
            portVariable: process.portVariable,
            environment: processEnvironment.get(process.name) ?? {},
            hostname: process.hostname,
            rootDomain: process.rootDomain,
          })),
          persistentPaths,
          environment,
          generatedEnvironment,
          github,
          tls,
        }
      : null,
  };
}

export async function completeAgentCommand(
  nodeId: string,
  input: {
    commandId: string;
    leaseToken: string;
    succeeded: boolean;
    cancelled?: boolean;
    output?: string;
    metadata?: {
      certificateExpiresAt?: string;
      deploymentCommitSha?: string;
    };
  },
) {
  const [commands] = await database().query<
    (RowDataPacket & {
      id: string;
      commandType: string;
      applicationId: string | null;
      payload: string | Record<string, unknown>;
      teamId: string | null;
      domainId: string | null;
      rootDomain: string | null;
      hostname: string | null;
      providerRecordId: string | null;
      deploymentId: string | null;
      applicationName: string | null;
    })[]
  >(
    `SELECT BIN_TO_UUID(c.id) AS id,c.command_type AS commandType,BIN_TO_UUID(c.application_id) AS applicationId,
            BIN_TO_UUID(c.deployment_id) AS deploymentId,c.payload,BIN_TO_UUID(a.team_id) AS teamId,a.name AS applicationName,
            BIN_TO_UUID(d.id) AS domainId,d.hostname,d.root_domain AS rootDomain,d.provider_record_id AS providerRecordId
     FROM node_commands c LEFT JOIN applications a ON a.id=c.application_id
     LEFT JOIN application_processes p
       ON p.id=UUID_TO_BIN(JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.processId')))
     LEFT JOIN domains d ON d.id=COALESCE(
       UUID_TO_BIN(JSON_UNQUOTE(JSON_EXTRACT(c.payload,'$.domainId'))),p.domain_id,a.domain_id
     )
     WHERE c.id=UUID_TO_BIN(?) AND c.node_id=UUID_TO_BIN(?) AND c.status='leased'
       AND c.lease_token_hash=? AND c.lease_expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
    [input.commandId, nodeId, tokenHash(input.leaseToken)],
  );
  const command = commands[0];
  if (!command) throw new Error("invalid_or_expired_command_lease");
  const payload =
    json<{ deploymentId?: string; previousApplicationStatus?: string }>(
      command.payload,
    ) ?? {};
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE node_commands SET status=?,
         output=IF(?, ?, RIGHT(CONCAT(COALESCE(output,''),'\n',COALESCE(?,'')),200000)),
         finished_at=CURRENT_TIMESTAMP(3),lease_token_hash=NULL,lease_expires_at=NULL
       WHERE id=UUID_TO_BIN(?)`,
      [
        input.cancelled
          ? "cancelled"
          : input.succeeded
            ? "succeeded"
            : "failed",
        input.succeeded,
        input.output?.slice(0, 200_000) ?? null,
        input.output?.slice(0, 200_000) ?? null,
        command.id,
      ],
    );
    if (
      command.applicationId &&
      ["deploy", "start", "stop", "restart", "delete"].includes(
        command.commandType,
      )
    ) {
      const successStatus = input.cancelled
        ? previousApplicationStatus(payload)
        : command.commandType === "stop"
          ? "stopped"
          : command.commandType === "delete"
            ? "deleted"
            : "running";
      await connection.execute(
        `UPDATE applications SET status=?,deleted_at=IF(?='deleted',CURRENT_TIMESTAMP(3),deleted_at) WHERE id=UUID_TO_BIN(?)`,
        [
          input.succeeded || input.cancelled ? successStatus : "failed",
          successStatus,
          command.applicationId,
        ],
      );
    }
    if (command.deploymentId) {
      await connection.execute(
        `UPDATE deployments SET status=?,commit_sha=COALESCE(?,commit_sha),finished_at=CURRENT_TIMESTAMP(3),
           started_at=COALESCE(started_at,CURRENT_TIMESTAMP(3))
         WHERE id=UUID_TO_BIN(?)`,
        [
          input.cancelled
            ? "cancelled"
            : input.succeeded
              ? "succeeded"
              : "failed",
          input.succeeded ? input.metadata?.deploymentCommitSha ?? null : null,
          command.deploymentId,
        ],
      );
    }
    if (
      input.succeeded &&
      command.applicationId &&
      ["deploy", "delete"].includes(command.commandType)
    ) {
      await connection.execute(
        "DELETE FROM application_process_cleanup WHERE application_id=UUID_TO_BIN(?)",
        [command.applicationId],
      );
    }
    if (
      command.domainId &&
      (command.commandType === "configure_proxy" ||
        command.commandType === "renew_certificate")
    ) {
      await connection.execute(
        `UPDATE domains SET proxy_status=?,certificate_renewed_at=IF(?,CURRENT_TIMESTAMP(3),certificate_renewed_at),
           certificate_expires_at=IF(?, ?, certificate_expires_at),last_error=? WHERE id=UUID_TO_BIN(?)`,
        [
          input.succeeded ? "active" : "error",
          input.succeeded,
          Boolean(input.metadata?.certificateExpiresAt),
          input.metadata?.certificateExpiresAt
            ? new Date(input.metadata.certificateExpiresAt)
            : null,
          input.succeeded
            ? null
            : (input.output?.slice(0, 4000) ?? "proxy_command_failed"),
          command.domainId,
        ],
      );
    }
    if (
      command.teamId &&
      command.deploymentId &&
      command.applicationName &&
      (input.cancelled || !input.succeeded)
    ) {
      await connection.execute(
        `INSERT INTO notifications
         (id,team_id,notification_type,severity,title,message,resource_type,resource_id)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?, 'deployment',?)`,
        [
          randomUUID(),
          command.teamId,
          input.cancelled ? "deployment_cancelled" : "deployment_failed",
          input.cancelled ? "info" : "error",
          `${command.applicationName} deployment ${input.cancelled ? "cancelled" : "failed"}`,
          input.cancelled
            ? "The node stopped the deployment after a cancellation request."
            : "The deployment failed. Open the application to inspect its build output.",
          command.deploymentId,
        ],
      );
    }
    if (
      command.teamId &&
      command.domainId &&
      !input.succeeded &&
      !input.cancelled &&
      (command.commandType === "configure_proxy" ||
        command.commandType === "renew_certificate")
    ) {
      await connection.execute(
        `INSERT INTO notifications
         (id,team_id,notification_type,severity,title,message,resource_type,resource_id)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'certificate_failed','error',?,?,'domain',?)`,
        [
          randomUUID(),
          command.teamId,
          `Certificate operation failed for ${command.hostname ?? "domain"}`,
          "The origin certificate could not be configured or renewed. Check the domain status for details.",
          command.domainId,
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

  if (
    input.succeeded &&
    command.commandType === "delete" &&
    command.teamId &&
    command.applicationId
  ) {
    const [domains] = await database().query<
      (RowDataPacket & {
        id: string;
        rootDomain: string;
        providerRecordId: string | null;
      })[]
    >(
      `SELECT BIN_TO_UUID(d.id) AS id,d.root_domain AS rootDomain,
              d.provider_record_id AS providerRecordId
       FROM application_domains ad JOIN domains d ON d.id=ad.domain_id
       WHERE ad.application_id=UUID_TO_BIN(?)`,
      [command.applicationId],
    );
    for (const domain of domains) {
      if (!domain.providerRecordId) continue;
      try {
        await removeCloudflareRecord(
          command.teamId,
          domain.rootDomain,
          domain.providerRecordId,
        );
        await database().execute(
          `UPDATE domains SET provider_record_id=NULL,status='pending',proxy_status='pending',
             certificate_renewed_at=NULL,certificate_expires_at=NULL,last_error=NULL WHERE id=UUID_TO_BIN(?)`,
          [domain.id],
        );
      } catch (error) {
        await database().execute(
          "UPDATE domains SET status='error',last_error=? WHERE id=UUID_TO_BIN(?)",
          [
            (error instanceof Error
              ? error.message
              : "cloudflare_dns_delete_failed"
            ).slice(0, 4000),
            domain.id,
          ],
        );
      }
    }
  }
}
