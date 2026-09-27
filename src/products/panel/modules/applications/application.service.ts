import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { effectiveUserId } from "../../../../shared/modules/auth/support-context.js";
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
      domain: string | null;
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
     LEFT JOIN domains d ON d.id=a.domain_id
     JOIN nodes n ON n.id=a.node_id
     LEFT JOIN pm2_process_snapshots p ON p.id=(
       SELECT ps.id FROM pm2_process_snapshots ps
       WHERE ps.node_id=a.node_id AND ps.process_name=a.pm2_process_name
       ORDER BY ps.id DESC LIMIT 1
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
        nodeId: string;
        domainId: string | null;
        status: string;
        teamSlug: string;
      })[]
    >(
      `SELECT a.detected_runtime AS runtime,a.repository_full_name AS repository,
              BIN_TO_UUID(a.node_id) AS nodeId,BIN_TO_UUID(a.domain_id) AS domainId,
              a.status,t.slug AS teamSlug
       FROM applications a JOIN teams t ON t.id=a.team_id
       WHERE a.id=UUID_TO_BIN(?) AND a.team_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL
       FOR UPDATE`,
      [applicationId, teamId],
    );
    const application = applications[0];
    if (!application) throw new Error("application_not_found");
    if (application.status === "deleting")
      throw new Error("application_deletion_in_progress");
    if (!application.domainId && input.processes.some((process) => process.public))
      throw new Error("background_application_cannot_be_public");

    const [existingProcesses] = await connection.query<
      (RowDataPacket & {
        id: string;
        name: string;
        processName: string;
        internalPort: number | null;
      })[]
    >(
      `SELECT BIN_TO_UUID(id) AS id,name,pm2_process_name AS processName,
              internal_port AS internalPort
       FROM application_processes WHERE application_id=UUID_TO_BIN(?) FOR UPDATE`,
      [applicationId],
    );
    const existingById = new Map(
      existingProcesses.map((process) => [process.id, process]),
    );
    const existingByName = new Map(
      existingProcesses.map((process) => [process.name, process]),
    );
    const claimedIds = new Set<string>();
    const processInputs = input.processes.map((process) => {
      const existing = process.id
        ? existingById.get(process.id)
        : existingByName.get(process.name);
      if (process.id && !existing) throw new Error("application_process_not_found");
      if (existing && claimedIds.has(existing.id))
        throw new Error("application_process_duplicate");
      if (existing) claimedIds.add(existing.id);
      return { ...process, existing };
    });

    const [domainRows] = await connection.query<
      (RowDataPacket & { id: string; hostname: string })[]
    >(
      `SELECT BIN_TO_UUID(d.id) AS id,d.hostname
       FROM application_domains ad JOIN domains d ON d.id=ad.domain_id
       WHERE ad.application_id=UUID_TO_BIN(?)`,
      [applicationId],
    );
    const domains = new Map(domainRows.map((domain) => [domain.hostname, domain.id]));
    const primaryHostname = domainRows.find(
      (domain) => domain.id === application.domainId,
    )?.hostname;

    const [usedPortRows] = await connection.query<
      (RowDataPacket & { internalPort: number })[]
    >(
      `SELECT a.internal_port AS internalPort FROM applications a
       WHERE a.node_id=UUID_TO_BIN(?) AND a.id<>UUID_TO_BIN(?)
         AND a.deleted_at IS NULL AND a.internal_port IS NOT NULL
       UNION
       SELECT p.internal_port AS internalPort FROM application_processes p
       JOIN applications a ON a.id=p.application_id
       WHERE p.node_id=UUID_TO_BIN(?) AND p.application_id<>UUID_TO_BIN(?)
         AND a.deleted_at IS NULL AND p.internal_port IS NOT NULL`,
      [application.nodeId, applicationId, application.nodeId, applicationId],
    );
    const usedPorts = new Set(usedPortRows.map((row) => Number(row.internalPort)));
    for (const process of processInputs) {
      if (
        ["web", "api"].includes(process.type) &&
        process.existing?.internalPort
      ) {
        usedPorts.add(Number(process.existing.internalPort));
      }
    }
    const newPorts = allocateApplicationPorts(
      processInputs.map((process) =>
        ["web", "api"].includes(process.type) &&
        !process.existing?.internalPort
          ? process.type
          : "worker",
      ),
      usedPorts,
    );
    const processes = processInputs.map((process, index) => {
      const requestedHostname =
        process.hostname && process.hostname !== primaryHostname
          ? process.hostname
          : undefined;
      const domainId = process.public
        ? requestedHostname
          ? domains.get(requestedHostname)
          : application.domainId
        : null;
      if (process.public && requestedHostname && !domainId)
        throw new Error("process_hostname_not_configured");
      const suffix = `-${process.name}`;
      const prefix = `${application.teamSlug}-${input.name}`.slice(
        0,
        120 - suffix.length,
      );
      return {
        ...process,
        id: process.existing?.id ?? randomUUID(),
        oldName: process.existing?.name ?? null,
        processName: process.existing?.processName ?? `${prefix}${suffix}`,
        internalPort: ["web", "api"].includes(process.type)
          ? process.existing?.internalPort ?? newPorts[index] ?? null
          : null,
        domainId: domainId ?? null,
      };
    });
    const primaryProcess = processes.find((process) => process.primary);
    const managedProcess = primaryProcess ?? processes.find((process) => process.enabled) ?? processes[0];
    if (!managedProcess) throw new Error("application_process_required");
    if (primaryProcess && !primaryProcess.internalPort)
      throw new Error("primary_process_port_required");

    const runtime = runtimeObject(application.runtime);
    if (input.installCommand) runtime.install = input.installCommand;
    if (application.repository && !runtime.install)
      throw new Error("application_install_command_required");
    runtime.build = input.buildCommand;
    runtime.checks = input.checkCommands;

    await connection.execute(
      `UPDATE applications
       SET name=?,repository_branch=?,auto_deploy=?,detected_runtime=?,
           pm2_process_name=?,internal_port=?
       WHERE id=UUID_TO_BIN(?)`,
      [
        input.name,
        input.branch,
        input.autoDeploy,
        Object.keys(runtime).length ? JSON.stringify(runtime) : null,
        managedProcess.processName,
        managedProcess.internalPort,
        applicationId,
      ],
    );

    const removedProcesses = existingProcesses.filter(
      (process) => !claimedIds.has(process.id),
    );
    for (const process of removedProcesses) {
      await connection.execute(
        `INSERT IGNORE INTO application_process_cleanup
         (application_id,node_id,pm2_process_name)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?)`,
        [applicationId, application.nodeId, process.processName],
      );
      await connection.execute(
        "DELETE FROM application_processes WHERE id=UUID_TO_BIN(?)",
        [process.id],
      );
    }

    const [scopedEnvironment] = await connection.query<
      (RowDataPacket & {
        processName: string;
        key: string;
        encryptedValue: Buffer;
        secret: number;
      })[]
    >(
      `SELECT process_name AS processName,variable_key AS \`key\`,
              encrypted_value AS encryptedValue,is_secret AS secret
       FROM application_environment_variables
       WHERE application_id=UUID_TO_BIN(?) AND environment='production' AND process_name<>'*'`,
      [applicationId],
    );
    await connection.execute(
      `DELETE FROM application_environment_variables
       WHERE application_id=UUID_TO_BIN(?) AND environment='production' AND process_name<>'*'`,
      [applicationId],
    );

    for (const process of processes) {
      const values: Array<string | number | boolean | null> = [
        process.id,
        applicationId,
        application.nodeId,
        process.domainId,
        process.name,
        process.processName,
        process.type,
        process.workingDirectory,
        process.executable,
        JSON.stringify(process.args),
        process.internalPort ?? null,
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
      ];
      if (process.existing) {
        await connection.execute(
          `UPDATE application_processes SET node_id=UUID_TO_BIN(?),domain_id=UUID_TO_BIN(?),
             name=?,pm2_process_name=?,process_type=?,working_directory=?,executable=?,arguments=?,
             internal_port=?,is_primary=?,is_public=?,routes=?,enabled=?,start_order=?,instances=?,
             restart_delay_ms=?,inherit_environment=?,health_path=?,host_variable=?,port_variable=?
           WHERE id=UUID_TO_BIN(?) AND application_id=UUID_TO_BIN(?)`,
          [
            application.nodeId,
            process.domainId,
            ...values.slice(4),
            process.id,
            applicationId,
          ],
        );
      } else {
        await connection.execute(
          `INSERT INTO application_processes
           (id,application_id,node_id,domain_id,name,pm2_process_name,process_type,
            working_directory,executable,arguments,internal_port,is_primary,is_public,routes,
            enabled,start_order,instances,restart_delay_ms,inherit_environment,health_path,
            host_variable,port_variable)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          values,
        );
      }
    }

    const renamedProcesses = new Map(
      processes
        .filter((process) => process.oldName)
        .map((process) => [process.oldName as string, process.name]),
    );
    for (const variable of scopedEnvironment) {
      const processName = renamedProcesses.get(variable.processName);
      if (!processName) continue;
      await connection.execute(
        `INSERT INTO application_environment_variables
         (id,application_id,environment,process_name,variable_key,encrypted_value,is_secret)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production',?,?,?,?)`,
        [
          randomUUID(),
          applicationId,
          processName,
          variable.key,
          variable.encryptedValue,
          variable.secret,
        ],
      );
    }
    for (const process of processes) {
      for (const [key, value] of Object.entries(process.environment ?? {})) {
        await connection.execute(
          `INSERT INTO application_environment_variables
           (id,application_id,environment,process_name,variable_key,encrypted_value,is_secret)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production',?,?,?,TRUE)
           ON DUPLICATE KEY UPDATE encrypted_value=VALUES(encrypted_value),is_secret=TRUE`,
          [
            randomUUID(),
            applicationId,
            process.name,
            key,
            encryptSecret(value),
          ],
        );
      }
    }
    if (primaryProcess) {
      await connection.execute(
        `INSERT INTO application_health_checks (application_id,path,next_check_at)
         VALUES (UUID_TO_BIN(?),?,CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE path=VALUES(path),enabled=TRUE,next_check_at=CURRENT_TIMESTAMP(3)`,
        [applicationId, primaryProcess.healthPath ?? "/"],
      );
    } else {
      await connection.execute(
        "DELETE FROM application_health_checks WHERE application_id=UUID_TO_BIN(?)",
        [applicationId],
      );
    }
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
          processes: input.processes.map((process) => process.name),
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
    `SELECT BIN_TO_UUID(node_id) AS nodeId,repository_full_name AS repository,
            detected_runtime AS runtime,status FROM applications
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
    if (commandType === "delete") {
      const [activeDeletions] = await connection.query<RowDataPacket[]>(
        `SELECT 1 FROM node_commands WHERE application_id=UUID_TO_BIN(?)
         AND command_type='delete' AND status IN ('queued','leased') LIMIT 1`,
        [applicationId],
      );
      if (activeDeletions[0])
        throw new Error("application_deletion_in_progress");
    }
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
  const backgroundApplication =
    input.processes.length > 0 && !input.processes.some((process) => process.public);
  if (!backgroundApplication && (!input.domain || !input.rootDomain))
    throw new Error("application_hostname_required");
  if (
    input.domain &&
    input.rootDomain &&
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
  const [connectedZones] = backgroundApplication
    ? [[] as ZoneRow[]]
    : await database().query<ZoneRow[]>(
        `SELECT r.display_name AS name
         FROM integration_resources r JOIN integrations i ON i.id=r.integration_id
         WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='cloudflare' AND i.disconnected_at IS NULL
           AND r.resource_type='zone' AND r.enabled=TRUE
         ORDER BY CHAR_LENGTH(r.display_name) DESC`,
        [team.id],
      );
  const zoneNames = connectedZones.map((zone) => zone.name.toLowerCase());
  if (!backgroundApplication && !zoneNames.includes(input.rootDomain!))
    throw new Error("cloudflare_zone_not_connected");
  const inspectedRuntime = input.repository
      ? await inspectRepository(
          team.id,
          effectiveUserId(user),
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
  const domainId = backgroundApplication ? null : randomUUID();
  const deploymentId = input.repository ? randomUUID() : null;
  const storagePath = backgroundApplication
    ? `/home/internal/${team.slug}/${input.name}`
    : `/home/${input.rootDomain}/${input.domain}`;
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
  const domains = new Map<string, { id: string; rootDomain: string }>();
  if (input.domain && input.rootDomain && domainId) {
    domains.set(input.domain, { id: domainId, rootDomain: input.rootDomain });
  }
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
  const sharedHostnames = new Set([
    ...(input.domain ? [input.domain] : []),
    ...input.additionalHostnames,
  ]);
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
        ? domains.get(process.hostname ?? input.domain!)?.id ?? domainId
        : null,
      hostname: process.primary ? input.domain : process.hostname,
      internalPort: null as number | null,
    };
  });
  const primaryProcess = processes.find((process) => process.primary);
  const managedProcess = primaryProcess ?? processes.find((process) => process.enabled) ?? processes[0];
  if (!managedProcess) throw new Error("application_process_required");
  const pm2ProcessName = managedProcess.pm2ProcessName;
  const connection = await database().getConnection();
  let internalPort: number | null = null;

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
    internalPort = managedProcess.internalPort;
    if (primaryProcess && !internalPort) throw new Error("primary_process_port_required");
    if (domainId && input.domain && input.rootDomain) {
      await connection.execute(
        `INSERT INTO domains (id,team_id,hostname,root_domain,record_type,dns_target,proxied,status)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,'CNAME',?,TRUE,'pending')`,
        [domainId, team.id, input.domain, input.rootDomain, node.cnameTarget],
      );
    }
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
    if (primaryProcess) {
      await connection.execute(
        `INSERT INTO application_health_checks (application_id,path,next_check_at)
         VALUES (UUID_TO_BIN(?),?,CURRENT_TIMESTAMP(3))`,
        [applicationId, primaryProcess.healthPath ?? "/"],
      );
    }

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

  let dnsStatus: "active" | "error" | "not_applicable" = backgroundApplication ? "not_applicable" : "active";
  let dnsError: string | null = null;
  let proxyStatus: "configuring" | "error" | "not_applicable" = backgroundApplication ? "not_applicable" : "configuring";
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
