import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";
import { encryptSecret } from "../../../../shared/security/secrets.js";

const settingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(365),
  nodeOfflineSeconds: z.number().int().min(30).max(3600),
  healthFailureThreshold: z.number().int().min(1).max(20),
  cooldownMinutes: z.number().int().min(1).max(1440),
  panelEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  emailRecipients: z.array(z.string().email()).max(20),
  webhookEnabled: z.boolean(),
  webhookUrl: z
    .union([
      z.string().url().refine((value) => new URL(value).protocol === "https:", "Webhook URL must use HTTPS"),
      z.literal(""),
      z.null(),
    ])
    .optional(),
  webhookSecret: z.union([z.string().min(16).max(512), z.literal(""), z.null()]).optional(),
  notifyNodeOffline: z.boolean(),
  notifyApplicationDown: z.boolean(),
  notifyResourceLimit: z.boolean(),
  notifyRecovery: z.boolean(),
  defaults: z.object({
    cpuPercent: z.number().positive().max(1000).nullable(),
    memoryMb: z.number().positive().max(1048576).nullable(),
    storageGb: z.number().positive().max(1048576).nullable(),
    monthlyTrafficGb: z.number().positive().max(1048576).nullable(),
  }),
});

const applicationParams = z.object({ applicationId: z.string().uuid() });
const applicationConfigSchema = z
  .object({
    health: z.object({
      enabled: z.boolean(),
      path: z.string().min(1).max(512).regex(/^\/(?!\/)/),
      intervalSeconds: z.number().int().min(15).max(3600),
      timeoutMs: z.number().int().min(500).max(30000),
      expectedStatusMin: z.number().int().min(100).max(599),
      expectedStatusMax: z.number().int().min(100).max(599),
    }),
    limits: z.object({
      cpuPercent: z.number().positive().max(1000).nullable(),
      memoryMb: z.number().positive().max(1048576).nullable(),
      storageGb: z.number().positive().max(1048576).nullable(),
      monthlyTrafficGb: z.number().positive().max(1048576).nullable(),
    }),
  })
  .refine(
    (value) => value.health.expectedStatusMin <= value.health.expectedStatusMax,
    { path: ["health", "expectedStatusMax"], message: "Invalid status range" },
  );

const timeseriesQuery = z.object({
  scope: z.enum(["node", "application"]),
  resourceId: z.string().uuid(),
  range: z.enum(["1h", "24h", "7d", "30d"]).default("24h"),
});

const rangeConfiguration = {
  "1h": { interval: "1 HOUR", bucket: 60 },
  "24h": { interval: "24 HOUR", bucket: 300 },
  "7d": { interval: "7 DAY", bucket: 3600 },
  "30d": { interval: "30 DAY", bucket: 14400 },
} as const;

function canManage(role: string) {
  return role === "owner" || role === "administrator";
}

function canWrite(role: string) {
  return canManage(role) || role === "developer";
}

function userFrom(request: FastifyRequest) {
  return (request as FastifyRequest & { sessionUser: SessionUser }).sessionUser;
}

function jsonArray(value: string | string[] | null) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function bytesFromMb(value: number | null) {
  return value === null ? null : Math.round(value * 1024 * 1024);
}

function bytesFromGb(value: number | null) {
  return value === null ? null : Math.round(value * 1024 * 1024 * 1024);
}

function mb(value: string | number | null) {
  return value === null ? null : Number(value) / (1024 * 1024);
}

function gb(value: string | number | null) {
  return value === null ? null : Number(value) / (1024 * 1024 * 1024);
}

export const monitoringRoutes: FastifyPluginAsync = async (app) => {
  app.get("/monitoring/summary", async (request) => {
    const team = teamFrom(request);
    const user = userFrom(request);
    const [alerts, applications, checks] = await Promise.all([
      database().query<(RowDataPacket & { total: number })[]>(
        `SELECT COUNT(*) AS total FROM monitoring_alerts
         WHERE team_id=UUID_TO_BIN(?) AND active=TRUE${user.isPlatformAdmin ? "" : " AND resource_type<>'node'"}`,
        [team.id],
      ),
      database().query<(RowDataPacket & { total: number })[]>(
        `SELECT COUNT(*) AS total FROM applications
         WHERE team_id=UUID_TO_BIN(?) AND deleted_at IS NULL AND status='failed'`,
        [team.id],
      ),
      database().query<(RowDataPacket & { total: number })[]>(
        `SELECT COUNT(*) AS total FROM application_health_checks h
         JOIN applications a ON a.id=h.application_id
         WHERE a.team_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL AND h.status='unhealthy'`,
        [team.id],
      ),
    ]);
    let offlineNodes = 0;
    if (user.isPlatformAdmin) {
      const [nodes] = await database().query<
        (RowDataPacket & { total: number })[]
      >("SELECT COUNT(*) AS total FROM nodes WHERE status='offline'");
      offlineNodes = Number(nodes[0]?.total ?? 0);
    }
    return {
      data: {
        activeAlerts: Number(alerts[0][0]?.total ?? 0),
        offlineNodes,
        failedApplications: Number(applications[0][0]?.total ?? 0),
        unhealthyChecks: Number(checks[0][0]?.total ?? 0),
      },
    };
  });

  app.get("/monitoring/settings", async (request) => {
    const team = teamFrom(request);
    const [rows] = await database().query<
      (RowDataPacket & {
        retentionDays: number;
        nodeOfflineSeconds: number;
        healthFailureThreshold: number;
        cooldownMinutes: number;
        panelEnabled: number;
        emailEnabled: number;
        emailRecipients: string | string[] | null;
        webhookEnabled: number;
        webhookConfigured: number;
        webhookSecretConfigured: number;
        notifyNodeOffline: number;
        notifyApplicationDown: number;
        notifyResourceLimit: number;
        notifyRecovery: number;
        defaultCpuPercent: number | null;
        defaultMemoryBytes: string | number | null;
        defaultStorageBytes: string | number | null;
        defaultTrafficBytesMonthly: string | number | null;
      })[]
    >(
      `SELECT retention_days AS retentionDays,node_offline_seconds AS nodeOfflineSeconds,
              health_failure_threshold AS healthFailureThreshold,
              notification_cooldown_minutes AS cooldownMinutes,panel_enabled AS panelEnabled,
              email_enabled AS emailEnabled,email_recipients AS emailRecipients,
              webhook_enabled AS webhookEnabled,encrypted_webhook_url IS NOT NULL AS webhookConfigured,
              encrypted_webhook_secret IS NOT NULL AS webhookSecretConfigured,
              notify_node_offline AS notifyNodeOffline,
              notify_application_down AS notifyApplicationDown,
              notify_resource_limit AS notifyResourceLimit,notify_recovery AS notifyRecovery,
              default_cpu_percent AS defaultCpuPercent,default_memory_bytes AS defaultMemoryBytes,
              default_storage_bytes AS defaultStorageBytes,
              default_traffic_bytes_monthly AS defaultTrafficBytesMonthly
       FROM team_monitoring_settings WHERE team_id=UUID_TO_BIN(?) LIMIT 1`,
      [team.id],
    );
    const row = rows[0];
    return {
      data: row
        ? {
            retentionDays: Number(row.retentionDays),
            nodeOfflineSeconds: Number(row.nodeOfflineSeconds),
            healthFailureThreshold: Number(row.healthFailureThreshold),
            cooldownMinutes: Number(row.cooldownMinutes),
            panelEnabled: Boolean(row.panelEnabled),
            emailEnabled: Boolean(row.emailEnabled),
            emailRecipients: jsonArray(row.emailRecipients),
            webhookEnabled: Boolean(row.webhookEnabled),
            webhookConfigured: Boolean(row.webhookConfigured),
            webhookSecretConfigured: Boolean(row.webhookSecretConfigured),
            notifyNodeOffline: Boolean(row.notifyNodeOffline),
            notifyApplicationDown: Boolean(row.notifyApplicationDown),
            notifyResourceLimit: Boolean(row.notifyResourceLimit),
            notifyRecovery: Boolean(row.notifyRecovery),
            defaults: {
              cpuPercent: row.defaultCpuPercent === null ? null : Number(row.defaultCpuPercent),
              memoryMb: mb(row.defaultMemoryBytes),
              storageGb: gb(row.defaultStorageBytes),
              monthlyTrafficGb: gb(row.defaultTrafficBytesMonthly),
            },
          }
        : {
            retentionDays: 30,
            nodeOfflineSeconds: 90,
            healthFailureThreshold: 3,
            cooldownMinutes: 30,
            panelEnabled: true,
            emailEnabled: false,
            emailRecipients: [],
            webhookEnabled: false,
            webhookConfigured: false,
            webhookSecretConfigured: false,
            notifyNodeOffline: true,
            notifyApplicationDown: true,
            notifyResourceLimit: true,
            notifyRecovery: true,
            defaults: { cpuPercent: null, memoryMb: null, storageGb: null, monthlyTrafficGb: null },
          },
    };
  });

  app.put("/monitoring/settings", async (request, reply) => {
    const body = settingsSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: "validation_error", details: body.error.flatten() });
    const team = teamFrom(request);
    if (!canManage(team.role))
      return reply.status(403).send({ error: "team_admin_required" });

    const [existing] = await database().query<
      (RowDataPacket & { url: Buffer | null; secret: Buffer | null })[]
    >(
      `SELECT encrypted_webhook_url AS url,encrypted_webhook_secret AS secret
       FROM team_monitoring_settings WHERE team_id=UUID_TO_BIN(?) LIMIT 1`,
      [team.id],
    );
    const webhookUrl =
      body.data.webhookUrl === undefined
        ? existing[0]?.url ?? null
        : body.data.webhookUrl
          ? encryptSecret(body.data.webhookUrl)
          : null;
    const webhookSecret =
      body.data.webhookSecret === undefined
        ? existing[0]?.secret ?? null
        : body.data.webhookSecret
          ? encryptSecret(body.data.webhookSecret)
          : null;
    if (body.data.webhookEnabled && (!webhookUrl || !webhookSecret))
      return reply.status(400).send({
        error: "webhook_url_and_secret_required",
      });

    await database().execute(
      `INSERT INTO team_monitoring_settings
       (team_id,retention_days,node_offline_seconds,health_failure_threshold,
        notification_cooldown_minutes,panel_enabled,email_enabled,email_recipients,
        webhook_enabled,encrypted_webhook_url,encrypted_webhook_secret,
        notify_node_offline,notify_application_down,notify_resource_limit,notify_recovery,
        default_cpu_percent,default_memory_bytes,default_storage_bytes,default_traffic_bytes_monthly)
       VALUES (UUID_TO_BIN(?),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE retention_days=VALUES(retention_days),
         node_offline_seconds=VALUES(node_offline_seconds),
         health_failure_threshold=VALUES(health_failure_threshold),
         notification_cooldown_minutes=VALUES(notification_cooldown_minutes),
         panel_enabled=VALUES(panel_enabled),email_enabled=VALUES(email_enabled),
         email_recipients=VALUES(email_recipients),webhook_enabled=VALUES(webhook_enabled),
         encrypted_webhook_url=VALUES(encrypted_webhook_url),
         encrypted_webhook_secret=VALUES(encrypted_webhook_secret),
         notify_node_offline=VALUES(notify_node_offline),
         notify_application_down=VALUES(notify_application_down),
         notify_resource_limit=VALUES(notify_resource_limit),notify_recovery=VALUES(notify_recovery),
         default_cpu_percent=VALUES(default_cpu_percent),default_memory_bytes=VALUES(default_memory_bytes),
         default_storage_bytes=VALUES(default_storage_bytes),
         default_traffic_bytes_monthly=VALUES(default_traffic_bytes_monthly)`,
      [
        team.id,
        body.data.retentionDays,
        body.data.nodeOfflineSeconds,
        body.data.healthFailureThreshold,
        body.data.cooldownMinutes,
        body.data.panelEnabled,
        body.data.emailEnabled,
        JSON.stringify(body.data.emailRecipients),
        body.data.webhookEnabled,
        webhookUrl,
        webhookSecret,
        body.data.notifyNodeOffline,
        body.data.notifyApplicationDown,
        body.data.notifyResourceLimit,
        body.data.notifyRecovery,
        body.data.defaults.cpuPercent,
        bytesFromMb(body.data.defaults.memoryMb),
        bytesFromGb(body.data.defaults.storageGb),
        bytesFromGb(body.data.defaults.monthlyTrafficGb),
      ],
    );
    return { data: { updated: true } };
  });

  app.get("/monitoring/applications", async (request) => {
    const team = teamFrom(request);
    const user = userFrom(request);
    const [rows] = await database().query<
      (RowDataPacket & Record<string, string | number | Date | null>)[]
    >(
      `SELECT BIN_TO_UUID(a.id) AS id,a.name,d.hostname,n.name AS nodeName,
              COALESCE(h.enabled,TRUE) AS healthEnabled,COALESCE(h.path,'/') AS healthPath,
              COALESCE(h.interval_seconds,60) AS healthIntervalSeconds,
              COALESCE(h.timeout_ms,10000) AS healthTimeoutMs,
              COALESCE(h.expected_status_min,200) AS expectedStatusMin,
              COALESCE(h.expected_status_max,399) AS expectedStatusMax,
              COALESCE(h.status,'unknown') AS healthStatus,h.last_http_status AS lastHttpStatus,
              h.last_response_ms AS lastResponseMs,h.last_checked_at AS lastCheckedAt,h.last_error AS lastError,
              l.cpu_percent AS cpuLimit,l.memory_bytes AS memoryLimit,l.storage_bytes AS storageLimit,
              l.traffic_bytes_monthly AS trafficLimit,
              s.default_cpu_percent AS defaultCpuLimit,s.default_memory_bytes AS defaultMemoryLimit,
              s.default_storage_bytes AS defaultStorageLimit,
              s.default_traffic_bytes_monthly AS defaultTrafficLimit,
              m.cpu_percent AS currentCpu,m.memory_bytes AS currentMemory,m.storage_bytes AS currentStorage,
              m.process_status AS processStatus,m.recorded_at AS metricRecordedAt,
              (SELECT COALESCE(SUM(monthly.traffic_bytes),0) FROM application_metrics monthly
               WHERE monthly.application_id=a.id AND monthly.recorded_at>=DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-01')) AS monthlyTraffic
       FROM applications a JOIN domains d ON d.id=a.domain_id JOIN nodes n ON n.id=a.node_id
       LEFT JOIN team_monitoring_settings s ON s.team_id=a.team_id
       LEFT JOIN application_health_checks h ON h.application_id=a.id
       LEFT JOIN application_resource_limits l ON l.application_id=a.id
       LEFT JOIN application_metrics m ON m.id=(
         SELECT latest.id FROM application_metrics latest
         WHERE latest.application_id=a.id ORDER BY latest.recorded_at DESC LIMIT 1
       )
       WHERE a.team_id=UUID_TO_BIN(?) AND a.deleted_at IS NULL ORDER BY a.name`,
      [team.id],
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        hostname: row.hostname,
        nodeName: user.isPlatformAdmin ? row.nodeName : undefined,
        health: {
          enabled: Boolean(row.healthEnabled), path: row.healthPath,
          intervalSeconds: Number(row.healthIntervalSeconds), timeoutMs: Number(row.healthTimeoutMs),
          expectedStatusMin: Number(row.expectedStatusMin), expectedStatusMax: Number(row.expectedStatusMax),
          status: row.healthStatus, lastHttpStatus: row.lastHttpStatus,
          lastResponseMs: row.lastResponseMs, lastCheckedAt: row.lastCheckedAt, lastError: row.lastError,
        },
        limits: {
          cpuPercent: row.cpuLimit === null ? null : Number(row.cpuLimit),
          memoryMb: mb(row.memoryLimit), storageGb: gb(row.storageLimit), monthlyTrafficGb: gb(row.trafficLimit),
        },
        effectiveLimits: {
          cpuPercent: Number(row.cpuLimit ?? row.defaultCpuLimit) || null,
          memoryMb: mb(row.memoryLimit ?? row.defaultMemoryLimit),
          storageGb: gb(row.storageLimit ?? row.defaultStorageLimit),
          monthlyTrafficGb: gb(row.trafficLimit ?? row.defaultTrafficLimit),
        },
        usage: {
          cpuPercent: Number(row.currentCpu ?? 0), memoryMb: mb(row.currentMemory) ?? 0,
          storageGb: gb(row.currentStorage) ?? 0, monthlyTrafficGb: gb(row.monthlyTraffic) ?? 0,
          processStatus: row.processStatus ?? "unknown", recordedAt: row.metricRecordedAt,
        },
      })),
    };
  });

  app.put("/monitoring/applications/:applicationId", async (request, reply) => {
    const params = applicationParams.safeParse(request.params);
    const body = applicationConfigSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: "validation_error", details: body.success ? undefined : body.error.flatten() });
    const team = teamFrom(request);
    if (!canWrite(team.role))
      return reply.status(403).send({ error: "team_write_required" });
    const [applications] = await database().query<RowDataPacket[]>(
      "SELECT 1 FROM applications WHERE id=UUID_TO_BIN(?) AND team_id=UUID_TO_BIN(?) AND deleted_at IS NULL LIMIT 1",
      [params.data.applicationId, team.id],
    );
    if (!applications[0]) return reply.status(404).send({ error: "application_not_found" });

    const connection = await database().getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO application_health_checks
         (application_id,enabled,path,interval_seconds,timeout_ms,expected_status_min,expected_status_max,next_check_at)
         VALUES (UUID_TO_BIN(?),?,?,?,?,?,?,CURRENT_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),path=VALUES(path),
           interval_seconds=VALUES(interval_seconds),timeout_ms=VALUES(timeout_ms),
           expected_status_min=VALUES(expected_status_min),expected_status_max=VALUES(expected_status_max),
           next_check_at=CURRENT_TIMESTAMP(3)`,
        [params.data.applicationId, body.data.health.enabled, body.data.health.path,
          body.data.health.intervalSeconds, body.data.health.timeoutMs,
          body.data.health.expectedStatusMin, body.data.health.expectedStatusMax],
      );
      await connection.execute(
        `INSERT INTO application_resource_limits
         (application_id,cpu_percent,memory_bytes,storage_bytes,traffic_bytes_monthly)
         VALUES (UUID_TO_BIN(?),?,?,?,?)
         ON DUPLICATE KEY UPDATE cpu_percent=VALUES(cpu_percent),memory_bytes=VALUES(memory_bytes),
           storage_bytes=VALUES(storage_bytes),traffic_bytes_monthly=VALUES(traffic_bytes_monthly)`,
        [params.data.applicationId, body.data.limits.cpuPercent,
          bytesFromMb(body.data.limits.memoryMb), bytesFromGb(body.data.limits.storageGb),
          bytesFromGb(body.data.limits.monthlyTrafficGb)],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return { data: { updated: true } };
  });

  app.get("/monitoring/timeseries", async (request, reply) => {
    const query = timeseriesQuery.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "validation_error" });
    const team = teamFrom(request);
    const configuration = rangeConfiguration[query.data.range];
    if (query.data.scope === "node") {
      if (!userFrom(request).isPlatformAdmin)
        return reply.status(403).send({ error: "platform_admin_required" });
      const [rows] = await database().query<RowDataPacket[]>(
        `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(m.recorded_at)/?)*?) AS recordedAt,
                AVG(m.load_1) AS load1,AVG(m.memory_used_percent) AS memoryPercent,
                AVG(m.disk_used_percent) AS diskPercent,
                MAX(m.network_received_bytes) AS networkReceivedBytes,
                MAX(m.network_sent_bytes) AS networkSentBytes
         FROM node_metrics m JOIN nodes n ON n.id=m.node_id
         WHERE n.id=UUID_TO_BIN(?)
           AND m.recorded_at>=UTC_TIMESTAMP()-INTERVAL ${configuration.interval}
         GROUP BY FLOOR(UNIX_TIMESTAMP(m.recorded_at)/?) ORDER BY recordedAt`,
        [configuration.bucket, configuration.bucket, query.data.resourceId, configuration.bucket],
      );
      return { data: { scope: "node", range: query.data.range, points: rows } };
    }

    const [metrics, health] = await Promise.all([
      database().query<RowDataPacket[]>(
        `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(m.recorded_at)/?)*?) AS recordedAt,
                AVG(m.cpu_percent) AS cpuPercent,AVG(m.memory_bytes) AS memoryBytes,
                AVG(m.storage_bytes) AS storageBytes,SUM(m.traffic_bytes) AS trafficBytes
         FROM application_metrics m JOIN applications a ON a.id=m.application_id
         WHERE a.team_id=UUID_TO_BIN(?) AND a.id=UUID_TO_BIN(?)
           AND m.recorded_at>=UTC_TIMESTAMP()-INTERVAL ${configuration.interval}
         GROUP BY FLOOR(UNIX_TIMESTAMP(m.recorded_at)/?) ORDER BY recordedAt`,
        [configuration.bucket, configuration.bucket, team.id, query.data.resourceId, configuration.bucket],
      ),
      database().query<RowDataPacket[]>(
        `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(h.recorded_at)/?)*?) AS recordedAt,
                AVG(h.response_ms) AS responseMs,AVG(h.healthy)*100 AS uptimePercent
         FROM application_health_samples h JOIN applications a ON a.id=h.application_id
         WHERE a.team_id=UUID_TO_BIN(?) AND a.id=UUID_TO_BIN(?)
           AND h.recorded_at>=UTC_TIMESTAMP()-INTERVAL ${configuration.interval}
         GROUP BY FLOOR(UNIX_TIMESTAMP(h.recorded_at)/?) ORDER BY recordedAt`,
        [configuration.bucket, configuration.bucket, team.id, query.data.resourceId, configuration.bucket],
      ),
    ]);
    return { data: { scope: "application", range: query.data.range, points: metrics[0], health: health[0] } };
  });

  app.get("/monitoring/alerts", async (request) => {
    const team = teamFrom(request);
    const user = userFrom(request);
    const [rows] = await database().query<RowDataPacket[]>(
      `SELECT BIN_TO_UUID(id) AS id,resource_type AS resourceType,BIN_TO_UUID(resource_id) AS resourceId,
              alert_key AS alertKey,event_type AS eventType,severity,title,message,active,
              occurrence_count AS occurrenceCount,first_triggered_at AS firstTriggeredAt,
              last_seen_at AS lastSeenAt,resolved_at AS resolvedAt
       FROM monitoring_alerts WHERE team_id=UUID_TO_BIN(?)
       ${user.isPlatformAdmin ? "" : "AND resource_type<>'node'"}
       ORDER BY active DESC,last_seen_at DESC LIMIT 100`,
      [team.id],
    );
    return { data: rows.map((row) => ({ ...row, active: Boolean(row.active) })) };
  });
};
