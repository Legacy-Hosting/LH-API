import type { RowDataPacket } from "mysql2";
import { env } from "../core/config/env.js";
import { closeDatabase, database } from "../core/database/mysql.js";
import { setMonitoringAlert } from "../products/panel/modules/monitoring/alert.service.js";

let stopping = false;
let lastRetentionRun = 0;

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function number(value: string | number | null) {
  return value === null ? null : Number(value);
}

function formatBytes(value: number) {
  if (value < 1024 * 1024 * 1024)
    return `${(value / (1024 * 1024)).toFixed(0)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function ensureMonitoringRows() {
  await database().execute(
    `INSERT IGNORE INTO team_monitoring_settings (team_id)
     SELECT id FROM teams`,
  );
  await database().execute(
    `INSERT IGNORE INTO application_health_checks (application_id,next_check_at)
     SELECT id,CURRENT_TIMESTAMP(3) FROM applications WHERE deleted_at IS NULL`,
  );
}

async function monitorNodes() {
  const [nodes] = await database().query<
    (RowDataPacket & {
      id: string;
      teamId: string;
      name: string;
      status: string;
      ageSeconds: number;
      offlineSeconds: number;
    })[]
  >(
    `SELECT BIN_TO_UUID(n.id) AS id,BIN_TO_UUID(n.team_id) AS teamId,n.name,n.status,
            TIMESTAMPDIFF(SECOND,COALESCE(n.last_heartbeat_at,n.created_at),UTC_TIMESTAMP(3)) AS ageSeconds,
            COALESCE(s.node_offline_seconds,90) AS offlineSeconds
     FROM nodes n LEFT JOIN team_monitoring_settings s ON s.team_id=n.team_id
     WHERE n.status<>'draining'`,
  );

  for (const node of nodes) {
    const offline = Number(node.ageSeconds) > Number(node.offlineSeconds);
    if (offline && node.status !== "offline") {
      await database().execute(
        "UPDATE nodes SET status='offline' WHERE id=UUID_TO_BIN(?) AND status<>'draining'",
        [node.id],
      );
    }
    await setMonitoringAlert({
      teamId: node.teamId,
      resourceType: "node",
      resourceId: node.id,
      resourceName: node.name,
      alertKey: "heartbeat_missing",
      eventType: "node_offline",
      severity: "error",
      title: `${node.name} is offline`,
      message: `No heartbeat has been received for ${node.ageSeconds} seconds.`,
      recoveryMessage: "The node is sending heartbeats again.",
      active: offline,
    });
  }
}

async function monitorProcesses() {
  const [applications] = await database().query<
    (RowDataPacket & {
      id: string;
      teamId: string;
      name: string;
      applicationStatus: string;
      nodeStatus: string;
      processStatus: string | null;
      ageSeconds: number | null;
      offlineSeconds: number;
    })[]
  >(
    `SELECT BIN_TO_UUID(a.id) AS id,BIN_TO_UUID(a.team_id) AS teamId,a.name,
            a.status AS applicationStatus,n.status AS nodeStatus,m.process_status AS processStatus,
            TIMESTAMPDIFF(SECOND,m.recorded_at,UTC_TIMESTAMP(3)) AS ageSeconds,
            COALESCE(s.node_offline_seconds,90) AS offlineSeconds
     FROM applications a JOIN nodes n ON n.id=a.node_id
     LEFT JOIN team_monitoring_settings s ON s.team_id=a.team_id
     LEFT JOIN application_metrics m ON m.id=(
       SELECT latest.id FROM application_metrics latest
       WHERE latest.application_id=a.id ORDER BY latest.id DESC LIMIT 1
     )
     WHERE a.deleted_at IS NULL`,
  );

  for (const application of applications) {
    const stale =
      application.ageSeconds === null ||
      Number(application.ageSeconds) > Number(application.offlineSeconds) * 2;
    const down =
      application.applicationStatus === "running" &&
      application.nodeStatus === "online" &&
      (stale || application.processStatus !== "online");
    await setMonitoringAlert({
      teamId: application.teamId,
      resourceType: "application",
      resourceId: application.id,
      resourceName: application.name,
      alertKey: "pm2_process_down",
      eventType: "application_down",
      severity: "error",
      title: `${application.name} process is down`,
      message: stale
        ? "The PM2 process has no recent metric sample."
        : `PM2 reports the process as ${application.processStatus ?? "missing"}.`,
      recoveryMessage: "The PM2 process is online again.",
      active: down,
    });
  }
}

type HealthRow = RowDataPacket & {
  applicationId: string;
  teamId: string;
  name: string;
  hostname: string;
  path: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedMin: number;
  expectedMax: number;
  failureThreshold: number;
  consecutiveFailures: number;
  previousStatus: string;
};

async function runHealthCheck(check: HealthRow) {
  await database().execute(
    `UPDATE application_health_checks
     SET next_check_at=UTC_TIMESTAMP(3)+INTERVAL ? SECOND
     WHERE application_id=UUID_TO_BIN(?)`,
    [check.intervalSeconds, check.applicationId],
  );

  const started = performance.now();
  let healthy = false;
  let httpStatus: number | null = null;
  let errorCode: string | null = null;
  try {
    const response = await fetch(`https://${check.hostname}${check.path}`, {
      method: "GET",
      headers: { "User-Agent": "Legacy-Hosting-Healthcheck/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(Number(check.timeoutMs)),
    });
    httpStatus = response.status;
    healthy =
      response.status >= Number(check.expectedMin) &&
      response.status <= Number(check.expectedMax);
    if (!healthy) errorCode = `unexpected_http_${response.status}`;
    await response.body?.cancel();
  } catch (error) {
    errorCode =
      error instanceof Error
        ? `${error.name}:${error.message}`.slice(0, 120)
        : "request_failed";
  }
  const responseMs = Math.max(0, Math.round(performance.now() - started));
  const failures = healthy ? 0 : Number(check.consecutiveFailures) + 1;
  const nextStatus = healthy
    ? "healthy"
    : failures >= Number(check.failureThreshold)
      ? "unhealthy"
      : check.previousStatus;

  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO application_health_samples
       (application_id,healthy,http_status,response_ms,error_code)
       VALUES (UUID_TO_BIN(?),?,?,?,?)`,
      [check.applicationId, healthy, httpStatus, responseMs, errorCode],
    );
    await connection.execute(
      `UPDATE application_health_checks SET consecutive_failures=?,status=?,last_http_status=?,
         last_response_ms=?,last_error=?,last_checked_at=UTC_TIMESTAMP(3),
         status_changed_at=IF(status<>?,UTC_TIMESTAMP(3),status_changed_at)
       WHERE application_id=UUID_TO_BIN(?)`,
      [failures, nextStatus, httpStatus, responseMs, errorCode, nextStatus, check.applicationId],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  await setMonitoringAlert({
    teamId: check.teamId,
    resourceType: "application",
    resourceId: check.applicationId,
    resourceName: check.name,
    alertKey: "http_healthcheck_failed",
    eventType: "application_down",
    severity: "error",
    title: `${check.name} health check failed`,
    message: `https://${check.hostname}${check.path} failed ${failures} consecutive checks (${errorCode ?? `HTTP ${httpStatus}`}).`,
    recoveryMessage: `The HTTP health check is healthy again (${responseMs} ms).`,
    active: nextStatus === "unhealthy",
  });
}

async function monitorHealthChecks() {
  const [checks] = await database().query<HealthRow[]>(
    `SELECT BIN_TO_UUID(a.id) AS applicationId,BIN_TO_UUID(a.team_id) AS teamId,
            a.name,d.hostname,h.path,h.interval_seconds AS intervalSeconds,h.timeout_ms AS timeoutMs,
            h.expected_status_min AS expectedMin,h.expected_status_max AS expectedMax,
            COALESCE(s.health_failure_threshold,3) AS failureThreshold,
            h.consecutive_failures AS consecutiveFailures,h.status AS previousStatus
     FROM application_health_checks h JOIN applications a ON a.id=h.application_id
     JOIN domains d ON d.id=a.domain_id
     LEFT JOIN team_monitoring_settings s ON s.team_id=a.team_id
     WHERE h.enabled=TRUE AND a.deleted_at IS NULL AND a.status='running'
       AND (h.next_check_at IS NULL OR h.next_check_at<=UTC_TIMESTAMP(3))
     ORDER BY h.next_check_at LIMIT 100`,
  );

  for (let index = 0; index < checks.length; index += 10) {
    await Promise.allSettled(checks.slice(index, index + 10).map(runHealthCheck));
  }

  const [dormant] = await database().query<
    (RowDataPacket & { applicationId: string; teamId: string; name: string })[]
  >(
    `SELECT BIN_TO_UUID(a.id) AS applicationId,BIN_TO_UUID(a.team_id) AS teamId,a.name
     FROM application_health_checks h JOIN applications a ON a.id=h.application_id
     WHERE h.status='unhealthy' AND (h.enabled=FALSE OR a.status<>'running' OR a.deleted_at IS NOT NULL)`,
  );
  for (const application of dormant) {
    await database().execute(
      `UPDATE application_health_checks SET status='unknown',consecutive_failures=0
       WHERE application_id=UUID_TO_BIN(?)`,
      [application.applicationId],
    );
    await setMonitoringAlert({
      teamId: application.teamId,
      resourceType: "application",
      resourceId: application.applicationId,
      resourceName: application.name,
      alertKey: "http_healthcheck_failed",
      eventType: "application_down",
      severity: "error",
      title: `${application.name} health check failed`,
      message: "The health check is inactive.",
      recoveryMessage: "The health alert was cleared because monitoring is inactive.",
      active: false,
    });
  }
}

type LimitRow = RowDataPacket & {
  id: string;
  teamId: string;
  name: string;
  cpu: string | number | null;
  memory: string | number | null;
  storage: string | number | null;
  traffic: string | number | null;
  cpuLimit: string | number | null;
  memoryLimit: string | number | null;
  storageLimit: string | number | null;
  trafficLimit: string | number | null;
};

async function resourceAlert(
  application: LimitRow,
  key: string,
  label: string,
  usage: number,
  limit: number | null,
  formatter: (value: number) => string,
) {
  const active = limit !== null && usage >= limit;
  await setMonitoringAlert({
    teamId: application.teamId,
    resourceType: "application",
    resourceId: application.id,
    resourceName: application.name,
    alertKey: `limit_${key}`,
    eventType: "resource_limit",
    severity: "warning",
    title: `${application.name} reached its ${label} limit`,
    message: `${label} usage is ${formatter(usage)} of ${formatter(limit ?? 0)}.`,
    recoveryMessage: `${label} usage is below the configured limit again.`,
    active,
  });
}

async function monitorResourceLimits() {
  const [applications] = await database().query<LimitRow[]>(
    `SELECT BIN_TO_UUID(a.id) AS id,BIN_TO_UUID(a.team_id) AS teamId,a.name,
            m.cpu_percent AS cpu,m.memory_bytes AS memory,m.storage_bytes AS storage,
            CASE
              WHEN COALESCE(l.traffic_bytes_monthly,s.default_traffic_bytes_monthly) IS NULL THEN 0
              ELSE (SELECT COALESCE(SUM(monthly.traffic_bytes),0) FROM application_metrics monthly
                    WHERE monthly.application_id=a.id
                      AND monthly.recorded_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01'))
            END AS traffic,
            COALESCE(l.cpu_percent,s.default_cpu_percent) AS cpuLimit,
            COALESCE(l.memory_bytes,s.default_memory_bytes) AS memoryLimit,
            COALESCE(l.storage_bytes,s.default_storage_bytes) AS storageLimit,
            COALESCE(l.traffic_bytes_monthly,s.default_traffic_bytes_monthly) AS trafficLimit
     FROM applications a LEFT JOIN team_monitoring_settings s ON s.team_id=a.team_id
     LEFT JOIN application_resource_limits l ON l.application_id=a.id
     LEFT JOIN application_metrics m ON m.id=(
       SELECT latest.id FROM application_metrics latest
       WHERE latest.application_id=a.id ORDER BY latest.id DESC LIMIT 1
     )
     WHERE a.deleted_at IS NULL`,
  );

  for (const application of applications) {
    await resourceAlert(application, "cpu", "CPU", Number(application.cpu ?? 0), number(application.cpuLimit), (value) => `${value.toFixed(1)}%`);
    await resourceAlert(application, "memory", "memory", Number(application.memory ?? 0), number(application.memoryLimit), formatBytes);
    await resourceAlert(application, "storage", "storage", Number(application.storage ?? 0), number(application.storageLimit), formatBytes);
    await resourceAlert(application, "traffic", "monthly traffic", Number(application.traffic ?? 0), number(application.trafficLimit), formatBytes);
  }
}

async function applyRetention() {
  if (Date.now() - lastRetentionRun < 60 * 60_000) return;
  lastRetentionRun = Date.now();
  await database().execute(
    `DELETE m FROM node_metrics m JOIN nodes n ON n.id=m.node_id
     LEFT JOIN team_monitoring_settings s ON s.team_id=n.team_id
     WHERE m.recorded_at<TIMESTAMPADD(DAY,-COALESCE(s.retention_days,30),UTC_TIMESTAMP(3))`,
  );
  await database().execute(
    `DELETE m FROM pm2_process_snapshots m JOIN nodes n ON n.id=m.node_id
     LEFT JOIN team_monitoring_settings s ON s.team_id=n.team_id
     WHERE m.recorded_at<TIMESTAMPADD(DAY,-COALESCE(s.retention_days,30),UTC_TIMESTAMP(3))`,
  );
  await database().execute(
    `DELETE m FROM application_metrics m JOIN applications a ON a.id=m.application_id
     LEFT JOIN team_monitoring_settings s ON s.team_id=a.team_id
     WHERE m.recorded_at<TIMESTAMPADD(DAY,-COALESCE(s.retention_days,30),UTC_TIMESTAMP(3))`,
  );
  await database().execute(
    `DELETE h FROM application_health_samples h JOIN applications a ON a.id=h.application_id
     LEFT JOIN team_monitoring_settings s ON s.team_id=a.team_id
     WHERE h.recorded_at<TIMESTAMPADD(DAY,-COALESCE(s.retention_days,30),UTC_TIMESTAMP(3))`,
  );
  await database().execute(
    "DELETE FROM agent_request_nonces WHERE seen_at<UTC_TIMESTAMP(3)-INTERVAL 10 MINUTE",
  );
  await database().execute(
    "DELETE FROM auth_challenges WHERE expires_at<UTC_TIMESTAMP(3)-INTERVAL 1 DAY",
  );
  await database().execute(
    "DELETE FROM user_sessions WHERE expires_at<UTC_TIMESTAMP(3)-INTERVAL 7 DAY OR revoked_at<UTC_TIMESTAMP(3)-INTERVAL 7 DAY",
  );
}

export async function runMonitoringCycle() {
  await ensureMonitoringRows();
  await monitorNodes();
  await monitorProcesses();
  await monitorHealthChecks();
  await monitorResourceLimits();
  await applyRetention();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

console.log("Legacy Hosting monitoring worker started");
while (!stopping) {
  const started = Date.now();
  try {
    await runMonitoringCycle();
  } catch (error) {
    console.error("Monitoring cycle failed", error);
  }
  await delay(Math.max(1_000, env.MONITORING_INTERVAL_MS - (Date.now() - started)));
}
await closeDatabase();
