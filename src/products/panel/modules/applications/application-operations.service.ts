import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";

function parseJson<T>(value: string | T | null): T | null {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function getApplicationDetails(
  applicationId: string,
  teamId: string,
) {
  const [applications] = await database().query<
    (RowDataPacket & {
      id: string;
      name: string;
      status: string;
      storagePath: string;
      processName: string;
      internalPort: number | null;
      repository: string | null;
      branch: string;
      autoDeploy: number;
      runtime: string | Record<string, unknown> | null;
      hostname: string;
      rootDomain: string;
      dnsStatus: string;
      proxyStatus: string;
      certificateExpiresAt: Date | null;
      lastError: string | null;
      nodeId: string;
      nodeName: string;
      nodeStatus: string;
      createdAt: Date;
      updatedAt: Date;
    })[]
  >(
    `SELECT BIN_TO_UUID(a.id) AS id,a.name,a.status,a.storage_path AS storagePath,
            a.pm2_process_name AS processName,a.internal_port AS internalPort,
            a.repository_full_name AS repository,a.repository_branch AS branch,a.auto_deploy AS autoDeploy,
            a.detected_runtime AS runtime,d.hostname,d.root_domain AS rootDomain,d.status AS dnsStatus,
            d.proxy_status AS proxyStatus,d.certificate_expires_at AS certificateExpiresAt,d.last_error AS lastError,
            BIN_TO_UUID(n.id) AS nodeId,n.name AS nodeName,n.status AS nodeStatus,
            a.created_at AS createdAt,a.updated_at AS updatedAt
     FROM applications a JOIN domains d ON d.id=a.domain_id JOIN nodes n ON n.id=a.node_id
     WHERE a.id=UUID_TO_BIN(?) AND a.team_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL LIMIT 1`,
    [applicationId, teamId],
  );
  const application = applications[0];
  if (!application) throw new Error("application_not_found");

  const [environment, deployments] = await Promise.all([
    database().query<
      (RowDataPacket & {
        key: string;
        secret: number;
        updatedAt: Date;
      })[]
    >(
      `SELECT variable_key AS \`key\`,is_secret AS secret,updated_at AS updatedAt
       FROM application_environment_variables
       WHERE application_id=UUID_TO_BIN(?) AND environment='production' ORDER BY variable_key`,
      [applicationId],
    ),
    database().query<
      (RowDataPacket & {
        id: string;
        commandId: string | null;
        rollbackOfDeploymentId: string | null;
        commitSha: string | null;
        source: string;
        status: string;
        startedAt: Date | null;
        finishedAt: Date | null;
        createdAt: Date;
      })[]
    >(
      `SELECT BIN_TO_UUID(d.id) AS id,BIN_TO_UUID(c.id) AS commandId,
              BIN_TO_UUID(d.rollback_of_deployment_id) AS rollbackOfDeploymentId,
              d.commit_sha AS commitSha,d.source,d.status,d.started_at AS startedAt,
              d.finished_at AS finishedAt,d.created_at AS createdAt
       FROM deployments d LEFT JOIN node_commands c ON c.deployment_id=d.id
       WHERE d.application_id=UUID_TO_BIN(?) ORDER BY d.created_at DESC LIMIT 100`,
      [applicationId],
    ),
  ]);

  return {
    ...application,
    autoDeploy: Boolean(application.autoDeploy),
    runtime: parseJson<Record<string, unknown>>(application.runtime),
    environment: environment[0].map((variable) => ({
      ...variable,
      secret: Boolean(variable.secret),
    })),
    deployments: deployments[0],
  };
}

export async function queueApplicationLogSnapshot(
  applicationId: string,
  teamId: string,
  lines: number,
) {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [applications] = await connection.query<
      (RowDataPacket & { nodeId: string })[]
    >(
      `SELECT BIN_TO_UUID(node_id) AS nodeId FROM applications
       WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND deleted_at IS NULL FOR UPDATE`,
      [applicationId, teamId],
    );
    const application = applications[0];
    if (!application) throw new Error("application_not_found");

    const [active] = await connection.query<
      (RowDataPacket & { id: string; status: string })[]
    >(
      `SELECT BIN_TO_UUID(id) AS id,status FROM node_commands
       WHERE application_id=UUID_TO_BIN(?) AND command_type='logs' AND status IN ('queued','leased')
       ORDER BY created_at DESC LIMIT 1`,
      [applicationId],
    );
    if (active[0]) {
      await connection.commit();
      return { commandId: active[0].id, status: active[0].status };
    }

    const commandId = randomUUID();
    await connection.execute(
      `INSERT INTO node_commands (id,node_id,application_id,command_type,payload)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'logs',?)`,
      [commandId, application.nodeId, applicationId, JSON.stringify({ lines })],
    );
    await connection.execute(
      `DELETE FROM node_commands WHERE application_id=UUID_TO_BIN(?) AND command_type='logs'
       AND status IN ('succeeded','failed','cancelled') AND finished_at<CURRENT_TIMESTAMP(3)-INTERVAL 7 DAY`,
      [applicationId],
    );
    await connection.commit();
    return { commandId, status: "queued" };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getApplicationCommand(
  applicationId: string,
  commandId: string,
  teamId: string,
) {
  const [commands] = await database().query<
    (RowDataPacket & {
      id: string;
      type: string;
      status: string;
      output: string | null;
      createdAt: Date;
      startedAt: Date | null;
      finishedAt: Date | null;
      cancelRequestedAt: Date | null;
    })[]
  >(
    `SELECT BIN_TO_UUID(c.id) AS id,c.command_type AS type,c.status,c.output,
            c.created_at AS createdAt,c.started_at AS startedAt,c.finished_at AS finishedAt,
            c.cancel_requested_at AS cancelRequestedAt
     FROM node_commands c JOIN applications a ON a.id=c.application_id
     WHERE c.id=UUID_TO_BIN(?) AND c.application_id=UUID_TO_BIN(?) AND a.team_id=UUID_TO_BIN(?) LIMIT 1`,
    [commandId, applicationId, teamId],
  );
  if (!commands[0]) throw new Error("command_not_found");
  return commands[0];
}

export async function queueRollback(
  applicationId: string,
  targetDeploymentId: string,
  teamId: string,
  user: SessionUser,
) {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [targets] = await connection.query<
      (RowDataPacket & {
        nodeId: string;
        commitSha: string;
        repository: string;
        applicationStatus: string;
      })[]
    >(
      `SELECT BIN_TO_UUID(a.node_id) AS nodeId,d.commit_sha AS commitSha,
              a.repository_full_name AS repository,a.status AS applicationStatus
       FROM applications a JOIN deployments d ON d.application_id=a.id
       WHERE a.id=UUID_TO_BIN(?) AND a.team_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL
         AND d.id=UUID_TO_BIN(?) AND d.status='succeeded' AND d.commit_sha IS NOT NULL
       FOR UPDATE`,
      [applicationId, teamId, targetDeploymentId],
    );
    const target = targets[0];
    if (!target) throw new Error("rollback_target_not_found");
    if (!target.repository) throw new Error("application_has_no_repository");

    const [activeDeployments] = await connection.query<RowDataPacket[]>(
      `SELECT 1 FROM node_commands WHERE application_id=UUID_TO_BIN(?)
       AND command_type='deploy' AND status IN ('queued','leased') LIMIT 1`,
      [applicationId],
    );
    if (activeDeployments[0]) throw new Error("deployment_already_in_progress");

    const deploymentId = randomUUID();
    const commandId = randomUUID();
    await connection.execute(
      `INSERT INTO deployments
       (id,application_id,rollback_of_deployment_id,commit_sha,source,status)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,'rollback','queued')`,
      [deploymentId, applicationId, targetDeploymentId, target.commitSha],
    );
    await connection.execute(
      `INSERT INTO node_commands (id,node_id,application_id,deployment_id,command_type,payload)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'deploy',?)`,
      [
        commandId,
        target.nodeId,
        applicationId,
        deploymentId,
        JSON.stringify({
          deploymentId,
          commitSha: target.commitSha,
          previousApplicationStatus: target.applicationStatus,
        }),
      ],
    );
    await connection.execute(
      "UPDATE applications SET status='deploying' WHERE id=UUID_TO_BIN(?)",
      [applicationId],
    );
    await connection.execute(
      `INSERT INTO audit_events
       (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','deployment.rollback_queued','application',?,?)`,
      [
        teamId,
        user.id,
        applicationId,
        JSON.stringify({
          deploymentId,
          targetDeploymentId,
          commitSha: target.commitSha,
        }),
      ],
    );
    await connection.commit();
    return {
      deploymentId,
      commandId,
      commitSha: target.commitSha,
      status: "queued",
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
