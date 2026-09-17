import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import type { TeamContext } from "../../../../shared/modules/teams/team.context.js";
import { encryptSecret } from "../../../../shared/security/secrets.js";
import type { createApplicationSchema } from "./application.schema.js";
import { inspectRepository } from "./repository-inspection.service.js";
import { provisionCloudflareCname } from "../../../../shared/modules/integrations/cloudflare-api.js";

type CreateApplication = z.infer<typeof createApplicationSchema>;
type NodeRow = RowDataPacket & { id: string; cnameTarget: string };

function bytes(value: number | string | null) {
  if (value === null) return "—";
  const amount = Number(value);
  if (amount < 1024 * 1024 * 1024)
    return `${Math.round(amount / (1024 * 1024))} MB`;
  return `${(amount / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function displayStatus(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export async function listApplications(teamId: string) {
  const [applications] = await database().query<
    (RowDataPacket & {
      id: string;
      name: string;
      domain: string;
      node: string;
      nodeId: string;
      status: string;
      repository: string | null;
      branch: string;
      autoDeploy: number;
      storagePath: string;
      cpu: number | null;
      memoryBytes: string | number | null;
      deployedAt: Date | null;
    })[]
  >(
    `SELECT BIN_TO_UUID(a.id) AS id,a.name,d.hostname AS domain,n.name AS node,BIN_TO_UUID(n.id) AS nodeId,
            a.status,a.repository_full_name AS repository,a.repository_branch AS branch,a.auto_deploy AS autoDeploy,
            a.storage_path AS storagePath,p.cpu_percent AS cpu,p.memory_bytes AS memoryBytes,
            dep.finished_at AS deployedAt
     FROM applications a
     JOIN domains d ON d.id=a.domain_id
     JOIN nodes n ON n.id=a.node_id
     LEFT JOIN pm2_process_snapshots p ON p.id=(
       SELECT ps.id FROM pm2_process_snapshots ps
       WHERE ps.node_id=a.node_id AND ps.process_name=a.pm2_process_name
       ORDER BY ps.recorded_at DESC LIMIT 1
     )
     LEFT JOIN deployments dep ON dep.id=(
       SELECT dd.id FROM deployments dd WHERE dd.application_id=a.id ORDER BY dd.created_at DESC LIMIT 1
     )
     WHERE a.team_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL ORDER BY a.created_at DESC`,
    [teamId],
  );

  return applications.map((application, index) => ({
    ...application,
    autoDeploy: Boolean(application.autoDeploy),
    status: displayStatus(application.status),
    cpu:
      application.cpu === null ? "—" : `${Number(application.cpu).toFixed(1)}%`,
    mem: bytes(application.memoryBytes),
    deploy: application.deployedAt?.toISOString() ?? "Not deployed",
    color: ["violet", "blue", "orange"][index % 3],
  }));
}

export async function replaceApplicationEnvironment(
  applicationId: string,
  teamId: string,
  environment: Record<string, string>,
) {
  const [applications] = await database().query<RowDataPacket[]>(
    "SELECT 1 FROM applications WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND deleted_at IS NULL LIMIT 1",
    [applicationId, teamId],
  );
  if (!applications[0]) throw new Error("application_not_found");
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "DELETE FROM application_environment_variables WHERE application_id=UUID_TO_BIN(?) AND environment='production'",
      [applicationId],
    );
    for (const [key, value] of Object.entries(environment)) {
      await connection.execute(
        `INSERT INTO application_environment_variables
         (id,application_id,environment,variable_key,encrypted_value,is_secret)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production',?,?,TRUE)`,
        [randomUUID(), applicationId, key, encryptSecret(value)],
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

export async function upsertApplicationEnvironmentVariable(
  applicationId: string,
  teamId: string,
  key: string,
  value: string,
) {
  const [applications] = await database().query<RowDataPacket[]>(
    "SELECT 1 FROM applications WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND deleted_at IS NULL LIMIT 1",
    [applicationId, teamId],
  );
  if (!applications[0]) throw new Error("application_not_found");
  await database().execute(
    `INSERT INTO application_environment_variables
     (id,application_id,environment,variable_key,encrypted_value,is_secret)
     VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production',?,?,TRUE)
     ON DUPLICATE KEY UPDATE encrypted_value=VALUES(encrypted_value),is_secret=TRUE`,
    [randomUUID(), applicationId, key, encryptSecret(value)],
  );
}

export async function deleteApplicationEnvironmentVariable(
  applicationId: string,
  teamId: string,
  key: string,
) {
  const [result] = await database().execute<ResultSetHeader>(
    `DELETE ev FROM application_environment_variables ev
     JOIN applications a ON a.id=ev.application_id
     WHERE ev.application_id=UUID_TO_BIN(?) AND a.team_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL
       AND ev.environment='production' AND ev.variable_key=?`,
    [applicationId, teamId, key],
  );
  return result.affectedRows > 0;
}

export async function queueApplicationCommand(
  applicationId: string,
  teamId: string,
  commandType: "deploy" | "start" | "stop" | "restart" | "delete",
) {
  const [applications] = await database().query<
    (RowDataPacket & {
      nodeId: string;
      repository: string | null;
      runtime: string | Record<string, unknown> | null;
      status: string;
    })[]
  >(
    `SELECT BIN_TO_UUID(node_id) AS nodeId,repository_full_name AS repository,detected_runtime AS runtime,status FROM applications
     WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND deleted_at IS NULL LIMIT 1`,
    [applicationId, teamId],
  );
  const application = applications[0];
  if (!application) throw new Error("application_not_found");
  if (commandType === "deploy" && (!application.repository || !application.runtime))
    throw new Error("application_not_deployable");
  const commandId = randomUUID();
  const deploymentId = commandType === "deploy" ? randomUUID() : null;
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      "SELECT id FROM applications WHERE id=UUID_TO_BIN(?) FOR UPDATE",
      [applicationId],
    );
    if (deploymentId) {
      const [activeDeployments] = await connection.query<RowDataPacket[]>(
        `SELECT 1 FROM node_commands WHERE application_id=UUID_TO_BIN(?)
         AND command_type='deploy' AND status IN ('queued','leased') LIMIT 1`,
        [applicationId],
      );
      if (activeDeployments[0])
        throw new Error("deployment_already_in_progress");
    }
    if (deploymentId) {
      await connection.execute(
        `INSERT INTO deployments (id,application_id,source,status) VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'manual','queued')`,
        [deploymentId, applicationId],
      );
    }
    await connection.execute(
      `INSERT INTO node_commands (id,node_id,application_id,deployment_id,command_type,payload)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?)`,
      [
        commandId,
        application.nodeId,
        applicationId,
        deploymentId,
        commandType,
        JSON.stringify({
          deploymentId,
          commitSha: null,
          previousApplicationStatus: application.status,
        }),
      ],
    );
    if (commandType === "delete" || commandType === "deploy") {
      await connection.execute(
        "UPDATE applications SET status=? WHERE id=UUID_TO_BIN(?)",
        [commandType === "delete" ? "deleting" : "deploying", applicationId],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { commandId, deploymentId, status: "queued" };
}

export async function createApplication(
  input: CreateApplication,
  team: TeamContext,
  user: SessionUser,
) {
  if (
    input.domain !== input.rootDomain &&
    !input.domain.endsWith(`.${input.rootDomain}`)
  ) {
    throw new Error("domain_outside_root");
  }

  const [nodes] = await database().query<NodeRow[]>(
    "SELECT BIN_TO_UUID(id) AS id,cname_target AS cnameTarget FROM nodes WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) LIMIT 1",
    [input.nodeId, team.id],
  );
  const node = nodes[0];
  if (!node) throw new Error("node_not_found");
  const detectedRuntime = input.repository
    ? await inspectRepository(team.id, input.repository, input.branch)
    : null;

  const applicationId = randomUUID();
  const domainId = randomUUID();
  const deploymentId = input.repository ? randomUUID() : null;
  const storagePath = `/home/${input.rootDomain}/${input.domain}`;
  const pm2ProcessName = `${team.slug}-${input.name}`.slice(0, 120);
  const connection = await database().getConnection();
  let internalPort = 0;

  try {
    await connection.beginTransaction();
    await connection.query(
      "SELECT id FROM nodes WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) FOR UPDATE",
      [node.id, team.id],
    );
    const [usedPorts] = await connection.query<
      (RowDataPacket & { internalPort: number })[]
    >(
      "SELECT internal_port AS internalPort FROM applications WHERE node_id=UUID_TO_BIN(?) AND deleted_at IS NULL AND internal_port IS NOT NULL",
      [node.id],
    );
    const used = new Set(usedPorts.map((row) => Number(row.internalPort)));
    internalPort =
      Array.from({ length: 1000 }, (_, index) => 3000 + index).find(
        (port) => !used.has(port),
      ) ?? 0;
    if (!internalPort) throw new Error("node_port_range_exhausted");
    await connection.execute(
      `INSERT INTO domains (id,team_id,hostname,root_domain,record_type,dns_target,proxied,status)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'CNAME',?,TRUE,'pending')`,
      [domainId, team.id, input.domain, input.rootDomain, node.cnameTarget],
    );
    await connection.execute(
      `INSERT INTO applications
       (id,team_id,node_id,domain_id,name,storage_path,pm2_process_name,internal_port,repository_full_name,repository_branch,auto_deploy,detected_runtime,status)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,'pending')`,
      [
        applicationId,
        team.id,
        node.id,
        domainId,
        input.name,
        storagePath,
        pm2ProcessName,
        internalPort,
        input.repository ?? null,
        input.branch,
        input.autoDeploy,
        detectedRuntime ? JSON.stringify(detectedRuntime) : null,
      ],
    );
    await connection.execute(
      `INSERT INTO application_health_checks (application_id,next_check_at)
       VALUES (UUID_TO_BIN(?),CURRENT_TIMESTAMP(3))`,
      [applicationId],
    );

    for (const [key, value] of Object.entries(input.environment)) {
      await connection.execute(
        `INSERT INTO application_environment_variables
         (id,application_id,environment,variable_key,encrypted_value,is_secret)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production',?,?,TRUE)`,
        [randomUUID(), applicationId, key, encryptSecret(value)],
      );
    }

    if (deploymentId) {
      await connection.execute(
        `INSERT INTO deployments (id,application_id,source,status) VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'manual','queued')`,
        [deploymentId, applicationId],
      );
      await connection.execute(
        `INSERT INTO node_commands (id,node_id,application_id,deployment_id,command_type,payload)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'deploy',?)`,
        [
          randomUUID(),
          node.id,
          applicationId,
          deploymentId,
          JSON.stringify({
            deploymentId,
            commitSha: null,
            previousApplicationStatus: "pending",
          }),
        ],
      );
    }
    await connection.execute(
      `INSERT INTO audit_events (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','application.created','application',?,?)`,
      [
        team.id,
        user.id,
        applicationId,
        JSON.stringify({
          domain: input.domain,
          nodeId: node.id,
          repository: input.repository ?? null,
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

  let dnsStatus: "active" | "error" = "active";
  let dnsError: string | null = null;
  let proxyStatus: "configuring" | "error" = "configuring";
  let proxyError: string | null = null;
  try {
    const dns = await provisionCloudflareCname({
      teamId: team.id,
      rootDomain: input.rootDomain,
      hostname: input.domain,
      target: node.cnameTarget,
      proxied: true,
    });
    await database().execute(
      `UPDATE domains SET integration_id=UUID_TO_BIN(?),provider_record_id=?,status='active',last_error=NULL
       WHERE id=UUID_TO_BIN(?)`,
      [dns.integrationId, dns.recordId, domainId],
    );
    const proxyConnection = await database().getConnection();
    try {
      await proxyConnection.beginTransaction();
      await proxyConnection.execute(
        `UPDATE domains SET proxy_status='configuring',last_error=NULL WHERE id=UUID_TO_BIN(?)`,
        [domainId],
      );
      await proxyConnection.execute(
        `INSERT INTO node_commands (id,node_id,application_id,command_type,payload)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'configure_proxy',JSON_OBJECT())`,
        [randomUUID(), node.id, applicationId],
      );
      await proxyConnection.commit();
    } catch (error) {
      await proxyConnection.rollback();
      proxyStatus = "error";
      const message =
        error instanceof Error ? error.message : "proxy_queue_failed";
      proxyError = message;
      await database().execute(
        "UPDATE domains SET proxy_status='error',last_error=? WHERE id=UUID_TO_BIN(?)",
        [message.slice(0, 4000), domainId],
      );
    } finally {
      proxyConnection.release();
    }
  } catch (error) {
    dnsStatus = "error";
    proxyStatus = "error";
    dnsError = error instanceof Error ? error.message : "cloudflare_dns_failed";
    proxyError = dnsError;
    await database().execute(
      "UPDATE domains SET status='error',proxy_status='error',last_error=? WHERE id=UUID_TO_BIN(?)",
      [dnsError.slice(0, 4000), domainId],
    );
  }

  return {
    id: applicationId,
    name: input.name,
    domain: input.domain,
    nodeId: node.id,
    storagePath,
    pm2ProcessName,
    internalPort,
    status: "Pending",
    deploymentId,
    detectedRuntime,
    dns: { status: dnsStatus, error: dnsError },
    proxy: { status: proxyStatus, error: proxyError },
  };
}
