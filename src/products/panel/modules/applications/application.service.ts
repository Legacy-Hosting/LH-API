import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import type { TeamContext } from "../../../../shared/modules/teams/team.context.js";
import { encryptSecret } from "../../../../shared/security/secrets.js";
import type {
  createApplicationSchema,
  updateApplicationSchema,
} from "./application.schema.js";
import { inspectRepository } from "./repository-inspection.service.js";
import { provisionCloudflareCname } from "../../../../shared/modules/integrations/cloudflare-api.js";

type CreateApplication = z.infer<typeof createApplicationSchema>;
type UpdateApplication = z.infer<typeof updateApplicationSchema>;
type NodeRow = RowDataPacket & { id: string; cnameTarget: string };
type ZoneRow = RowDataPacket & { name: string };

const FIRST_APPLICATION_PORT = 3000;
const LAST_APPLICATION_PORT = 3999;

export function allocateApplicationPorts(
  processTypes: string[],
  usedPorts: Iterable<number>,
) {
  const used = new Set([...usedPorts].map(Number));
  let candidate = FIRST_APPLICATION_PORT;
  return processTypes.map((type) => {
    if (type !== "web" && type !== "api") return null;
    while (candidate <= LAST_APPLICATION_PORT && used.has(candidate))
      candidate += 1;
    if (candidate > LAST_APPLICATION_PORT)
      throw new Error("node_port_range_exhausted");
    const allocated = candidate;
    used.add(allocated);
    candidate += 1;
    return allocated;
  });
}

function zoneForHostname(hostname: string, zones: string[]) {
  return zones.find(
    (zone) => hostname === zone || hostname.endsWith(`.${zone}`),
  );
}

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
      "DELETE FROM application_environment_variables WHERE application_id=UUID_TO_BIN(?) AND environment='production' AND process_name='*'",
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
       AND ev.environment='production' AND ev.process_name='*' AND ev.variable_key=?`,
    [applicationId, teamId, key],
  );
  return result.affectedRows > 0;
}

function runtimeObject(value: string | Record<string, unknown> | null) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function updateApplication(
  applicationId: string,
  teamId: string,
  user: SessionUser,
  input: UpdateApplication,
) {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [applications] = await connection.query<
      (RowDataPacket & {
        runtime: string | Record<string, unknown> | null;
        repository: string | null;
      })[]
    >(
      `SELECT detected_runtime AS runtime,repository_full_name AS repository
       FROM applications
       WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND deleted_at IS NULL
       FOR UPDATE`,
      [applicationId, teamId],
    );
    const application = applications[0];
    if (!application) throw new Error("application_not_found");

    const runtime = runtimeObject(application.runtime);
    if (input.installCommand) runtime.install = input.installCommand;
    if (application.repository && !runtime.install)
      throw new Error("application_install_command_required");
    runtime.build = input.buildCommand;
    runtime.checks = input.checkCommands;

    await connection.execute(
      `UPDATE applications
       SET name=?,repository_branch=?,auto_deploy=?,detected_runtime=?
       WHERE id=UUID_TO_BIN(?)`,
      [
        input.name,
        input.branch,
        input.autoDeploy,
        Object.keys(runtime).length ? JSON.stringify(runtime) : null,
        applicationId,
      ],
    );
    await connection.execute(
      "DELETE FROM application_persistent_paths WHERE application_id=UUID_TO_BIN(?)",
      [applicationId],
    );
    for (const path of input.persistentPaths) {
      await connection.execute(
        `INSERT INTO application_persistent_paths
         (id,application_id,relative_path,path_type)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?)`,
        [randomUUID(), applicationId, path.path, path.type],
      );
    }
    await connection.execute(
      `INSERT INTO audit_events
       (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','application.updated','application',?,?)`,
      [
        teamId,
        user.id,
        applicationId,
        JSON.stringify({
          name: input.name,
          branch: input.branch,
          autoDeploy: input.autoDeploy,
          persistentPaths: input.persistentPaths.length,
        }),
      ],
    );
    await connection.commit();
    return { updated: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
    "SELECT BIN_TO_UUID(id) AS id,cname_target AS cnameTarget FROM nodes WHERE id=UUID_TO_BIN(?) AND status='online' LIMIT 1",
    [input.nodeId],
  );
  const node = nodes[0];
  if (!node) throw new Error("node_not_found");
  const [connectedZones] = await database().query<ZoneRow[]>(
    `SELECT r.display_name AS name
     FROM integration_resources r JOIN integrations i ON i.id=r.integration_id
     WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='cloudflare' AND i.disconnected_at IS NULL
       AND r.resource_type='zone' AND r.enabled=TRUE
     ORDER BY CHAR_LENGTH(r.display_name) DESC`,
    [team.id],
  );
  const zoneNames = connectedZones.map((zone) => zone.name.toLowerCase());
  if (!zoneNames.includes(input.rootDomain))
    throw new Error("cloudflare_zone_not_connected");
  const inspectedRuntime = input.repository
      ? await inspectRepository(
          team.id,
          input.repository,
          input.branch,
          {
            requireStartCommand: input.processes.length === 0,
            manualRuntime:
              input.processes.length > 0 && input.installCommand
                ? {
                    install: input.installCommand,
                    build: input.buildCommand,
                  }
                : undefined,
          },
        )
    : null;
  const detectedRuntime = inspectedRuntime
    ? {
        ...inspectedRuntime,
        install: input.installCommand ?? inspectedRuntime.install,
        build:
          input.buildCommand === undefined
            ? inspectedRuntime.build
            : input.buildCommand,
        checks: input.checkCommands,
      }
    : null;

  const applicationId = randomUUID();
  const domainId = randomUUID();
  const deploymentId = input.repository ? randomUUID() : null;
  const storagePath = `/home/${input.rootDomain}/${input.domain}`;
  const requestedProcesses = input.processes.length
    ? input.processes
    : [
        {
          name: "web",
          type: "web" as const,
          workingDirectory: ".",
          executable: detectedRuntime?.start?.command ?? "npm",
          args: detectedRuntime?.start?.args ?? ["start"],
          primary: true,
          public: true,
          routes: ["/"],
          hostname: undefined,
          enabled: true,
          startOrder: 0,
          instances: 1,
          restartDelayMs: 1000,
          inheritEnvironment: true,
          healthPath: "/health",
          hostVariable: undefined,
          portVariable: undefined,
          environment: {},
        },
      ];
  const domains = new Map<string, { id: string; rootDomain: string }>([
    [input.domain, { id: domainId, rootDomain: input.rootDomain }],
  ]);
  for (const hostname of [
    ...input.additionalHostnames,
    ...requestedProcesses.flatMap((process) =>
      process.hostname ? [process.hostname] : [],
    ),
  ]) {
    if (domains.has(hostname)) continue;
    const rootDomain = zoneForHostname(hostname, zoneNames);
    if (!rootDomain) throw new Error("cloudflare_zone_not_connected");
    domains.set(hostname, { id: randomUUID(), rootDomain });
  }
  const sharedHostnames = new Set([input.domain, ...input.additionalHostnames]);
  const processes = requestedProcesses.map((process) => {
    const suffix = input.processes.length ? `-${process.name}` : "";
    const prefix = `${team.slug}-${input.name}`.slice(
      0,
      120 - suffix.length,
    );
    return {
      ...process,
      configuredHostname: process.hostname ?? null,
      id: randomUUID(),
      pm2ProcessName: `${prefix}${suffix}`,
      domainId: process.public
        ? domains.get(process.hostname ?? input.domain)?.id ?? domainId
        : null,
      hostname: process.primary ? input.domain : process.hostname,
      internalPort: null as number | null,
    };
  });
  const primaryProcess = processes.find((process) => process.primary);
  if (!primaryProcess) throw new Error("primary_process_required");
  const pm2ProcessName = primaryProcess.pm2ProcessName;
  const connection = await database().getConnection();
  let internalPort = 0;

  try {
    await connection.beginTransaction();
    const [lockedNodes] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM nodes WHERE id=UUID_TO_BIN(?) AND status='online' FOR UPDATE",
      [node.id],
    );
    if (!lockedNodes[0]) throw new Error("node_not_found");
    const [usedPorts] = await connection.query<
      (RowDataPacket & { internalPort: number })[]
    >(
      `SELECT internal_port AS internalPort FROM applications
       WHERE node_id=UUID_TO_BIN(?) AND deleted_at IS NULL AND internal_port IS NOT NULL
       UNION
       SELECT p.internal_port AS internalPort FROM application_processes p
       JOIN applications a ON a.id=p.application_id
       WHERE p.node_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL AND p.internal_port IS NOT NULL`,
      [node.id, node.id],
    );
    const allocatedPorts = allocateApplicationPorts(
      processes.map((process) => process.type),
      usedPorts.map((row) => Number(row.internalPort)),
    );
    processes.forEach((process, index) => {
      process.internalPort = allocatedPorts[index] ?? null;
    });
    internalPort = primaryProcess.internalPort ?? 0;
    if (!internalPort) throw new Error("primary_process_port_required");
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
    for (const [hostname, domain] of domains) {
      const additionalDomainId = domain.id;
      if (additionalDomainId !== domainId) {
        await connection.execute(
          `INSERT INTO domains (id,team_id,hostname,root_domain,record_type,dns_target,proxied,status)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'CNAME',?,TRUE,'pending')`,
          [
            additionalDomainId,
            team.id,
            hostname,
            domain.rootDomain,
            node.cnameTarget,
          ],
        );
      }
      await connection.execute(
        `INSERT INTO application_domains (application_id,domain_id,is_primary,routing_mode)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?)`,
        [
          applicationId,
          additionalDomainId,
          additionalDomainId === domainId,
          sharedHostnames.has(hostname) ? "shared" : "dedicated",
        ],
      );
    }
    for (const process of processes) {
      await connection.execute(
        `INSERT INTO application_processes
         (id,application_id,node_id,domain_id,name,pm2_process_name,process_type,
          working_directory,executable,arguments,internal_port,is_primary,is_public,routes,
          enabled,start_order,instances,restart_delay_ms,inherit_environment,health_path,
          host_variable,port_variable)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          process.id,
          applicationId,
          node.id,
          process.domainId,
          process.name,
          process.pm2ProcessName,
          process.type,
          process.workingDirectory,
          process.executable,
          JSON.stringify(process.args),
          process.internalPort,
          process.primary,
          process.public,
          JSON.stringify(process.routes),
          process.enabled,
          process.startOrder,
          process.instances,
          process.restartDelayMs,
          process.inheritEnvironment,
          process.healthPath ?? null,
          process.hostVariable ?? null,
          process.portVariable ?? null,
        ],
      );
      for (const [key, value] of Object.entries(process.environment)) {
        await connection.execute(
          `INSERT INTO application_environment_variables
           (id,application_id,environment,process_name,variable_key,encrypted_value,is_secret)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production',?,?,?,TRUE)`,
          [randomUUID(), applicationId, process.name, key, encryptSecret(value)],
        );
      }
    }
    await connection.execute(
      `INSERT INTO application_health_checks (application_id,path,next_check_at)
       VALUES (UUID_TO_BIN(?),?,CURRENT_TIMESTAMP(3))`,
      [applicationId, primaryProcess.healthPath ?? "/"],
    );

    for (const [key, value] of Object.entries(input.environment)) {
      await connection.execute(
        `INSERT INTO application_environment_variables
         (id,application_id,environment,variable_key,encrypted_value,is_secret)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production',?,?,TRUE)`,
        [randomUUID(), applicationId, key, encryptSecret(value)],
      );
    }
    for (const path of input.persistentPaths) {
      await connection.execute(
        `INSERT INTO application_persistent_paths (id,application_id,relative_path,path_type)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?)`,
        [randomUUID(), applicationId, path.path, path.type],
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
          processes: processes.map((process) => process.name),
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
  const domainConfigurations = [...domains].map(([hostname, domain]) => ({
    id: domain.id,
    hostname,
    rootDomain: domain.rootDomain,
    routes: processes
      .filter(
        (process) =>
          process.public &&
          process.internalPort &&
          (process.configuredHostname === hostname ||
            (sharedHostnames.has(hostname) && !process.configuredHostname)),
      )
      .flatMap((process) =>
        process.routes.map((prefix) => ({
          prefix,
          port: process.internalPort!,
          processName: process.name,
        })),
      ),
  }));
  for (const domain of domainConfigurations) {
    try {
      const dns = await provisionCloudflareCname({
        teamId: team.id,
        rootDomain: domain.rootDomain,
        hostname: domain.hostname,
        target: node.cnameTarget,
        proxied: true,
      });
      await database().execute(
        `UPDATE domains SET integration_id=UUID_TO_BIN(?),provider_record_id=?,status='active',
           proxy_status='configuring',last_error=NULL WHERE id=UUID_TO_BIN(?)`,
        [dns.integrationId, dns.recordId, domain.id],
      );
      await database().execute(
        `INSERT INTO node_commands (id,node_id,application_id,command_type,payload)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'configure_proxy',?)`,
        [
          randomUUID(),
          node.id,
          applicationId,
          JSON.stringify({
            domainId: domain.id,
            hostname: domain.hostname,
            rootDomain: domain.rootDomain,
            routes: domain.routes,
          }),
        ],
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "cloudflare_dns_failed";
      await database().execute(
        "UPDATE domains SET status='error',proxy_status='error',last_error=? WHERE id=UUID_TO_BIN(?)",
        [message.slice(0, 4000), domain.id],
      );
      if (domain.id === domainId) {
        dnsStatus = "error";
        proxyStatus = "error";
        dnsError = message;
        proxyError = message;
      }
    }
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
    processes: processes.map((process) => ({
      id: process.id,
      name: process.name,
      type: process.type,
      primary: process.primary,
      hostname: process.hostname ?? null,
      internalPort: process.internalPort,
      pm2ProcessName: process.pm2ProcessName,
    })),
    dns: { status: dnsStatus, error: dnsError },
    proxy: { status: proxyStatus, error: proxyError },
  };
}
