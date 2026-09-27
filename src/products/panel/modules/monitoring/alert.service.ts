import { createHmac, randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { env } from "../../../../core/config/env.js";
import { database } from "../../../../core/database/mysql.js";
import { decryptSecret } from "../../../../shared/security/secrets.js";

export type AlertEventType =
  | "node_offline"
  | "application_down"
  | "resource_limit";

type AlertInput = {
  teamId: string;
  resourceType: "node" | "application";
  resourceId: string;
  resourceName: string;
  alertKey: string;
  eventType: AlertEventType;
  severity: "warning" | "error";
  title: string;
  message: string;
  recoveryMessage: string;
  active: boolean;
};

type SettingsRow = RowDataPacket & {
  panelEnabled: number;
  emailEnabled: number;
  emailRecipients: string | string[] | null;
  webhookEnabled: number;
  encryptedWebhookUrl: Buffer | null;
  encryptedWebhookSecret: Buffer | null;
  notifyNodeOffline: number;
  notifyApplicationDown: number;
  notifyResourceLimit: number;
  notifyRecovery: number;
  cooldownMinutes: number;
};

type AlertRow = RowDataPacket & {
  id: string;
  active: number;
  lastNotifiedAt: Date | null;
};

type WebhookSettings = {
  enabled: number;
  encryptedUrl: Buffer | null;
  encryptedSecret: Buffer | null;
};

function stringArray(value: string | string[] | null) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function eventEnabled(settings: SettingsRow | undefined, event: AlertEventType) {
  if (!settings) return true;
  if (event === "node_offline") return Boolean(settings.notifyNodeOffline);
  if (event === "application_down")
    return Boolean(settings.notifyApplicationDown);
  return Boolean(settings.notifyResourceLimit);
}

function html(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function settingsForTeam(teamId: string) {
  const [rows] = await database().query<SettingsRow[]>(
    `SELECT panel_enabled AS panelEnabled,email_enabled AS emailEnabled,
            email_recipients AS emailRecipients,webhook_enabled AS webhookEnabled,
            encrypted_webhook_url AS encryptedWebhookUrl,
            encrypted_webhook_secret AS encryptedWebhookSecret,
            notify_node_offline AS notifyNodeOffline,
            notify_application_down AS notifyApplicationDown,
            notify_resource_limit AS notifyResourceLimit,
            notify_recovery AS notifyRecovery,
            notification_cooldown_minutes AS cooldownMinutes
     FROM team_monitoring_settings WHERE team_id=UUID_TO_BIN(?) LIMIT 1`,
    [teamId],
  );
  return rows[0];
}

async function fallbackRecipients(teamId: string) {
  const [rows] = await database().query<(RowDataPacket & { email: string })[]>(
    `SELECT u.email FROM team_members tm JOIN users u ON u.id=tm.user_id
     WHERE tm.team_id=UUID_TO_BIN(?) AND tm.role IN ('owner','administrator') AND u.status='active'`,
    [teamId],
  );
  return rows.map((row) => row.email);
}

async function webhookForAlert(settings: SettingsRow | undefined, input: AlertInput): Promise<WebhookSettings | undefined> {
  if (input.resourceType === "node") {
    return settings
      ? {
          enabled: settings.webhookEnabled,
          encryptedUrl: settings.encryptedWebhookUrl,
          encryptedSecret: settings.encryptedWebhookSecret,
        }
      : undefined;
  }
  const [rows] = await database().query<(
    RowDataPacket & WebhookSettings
  )[]>(
    `SELECT enabled,encrypted_webhook_url AS encryptedUrl,
            encrypted_webhook_secret AS encryptedSecret
     FROM application_monitoring_webhooks
     WHERE application_id=UUID_TO_BIN(?) LIMIT 1`,
    [input.resourceId],
  );
  return rows[0];
}

async function dispatchExternal(
  settings: SettingsRow | undefined,
  input: AlertInput,
  title: string,
  message: string,
  state: "triggered" | "resolved",
) {
  const payload = JSON.stringify({
    event: input.eventType,
    state,
    severity: input.severity,
    title,
    message,
    resource: {
      type: input.resourceType,
      id: input.resourceId,
      name: input.resourceName,
    },
    occurredAt: new Date().toISOString(),
  });

  if (settings?.emailEnabled) {
    const recipients = stringArray(settings.emailRecipients);
    const to = recipients.length ? recipients : await fallbackRecipients(input.teamId);
    if (to.length && env.RESEND_API_KEY && env.ALERT_EMAIL_FROM) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: env.ALERT_EMAIL_FROM,
            to,
            subject: `[Legacy Hosting] ${title}`,
            html: `<h2>${html(title)}</h2><p>${html(message)}</p><p><small>${html(input.resourceType)}: ${html(input.resourceName)}</small></p>`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          console.error(`Alert email rejected with status ${response.status}`);
      } catch (error) {
        console.error("Alert email failed", error);
      }
    }
  }

  const webhook = await webhookForAlert(settings, input);
  if (webhook?.enabled && webhook.encryptedUrl) {
    try {
      const webhookUrl = decryptSecret(webhook.encryptedUrl);
      const secret = webhook.encryptedSecret
        ? decryptSecret(webhook.encryptedSecret)
        : null;
      const signature = secret
        ? createHmac("sha256", secret).update(payload).digest("hex")
        : null;
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Legacy-Hosting-Monitor/1.0",
          "X-LH-Event": input.eventType,
          ...(signature ? { "X-LH-Signature-256": `sha256=${signature}` } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        console.error(`Alert webhook rejected with status ${response.status}`);
    } catch (error) {
      console.error("Alert webhook failed", error);
    }
  }
}

export async function setMonitoringAlert(input: AlertInput) {
  const settings = await settingsForTeam(input.teamId);
  if (!eventEnabled(settings, input.eventType)) return;

  const connection = await database().getConnection();
  let shouldNotify = false;
  let state: "triggered" | "resolved" = input.active
    ? "triggered"
    : "resolved";
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<AlertRow[]>(
      `SELECT BIN_TO_UUID(id) AS id,active,last_notified_at AS lastNotifiedAt
       FROM monitoring_alerts
       WHERE team_id=UUID_TO_BIN(?) AND resource_type=? AND resource_id=UUID_TO_BIN(?) AND alert_key=?
       FOR UPDATE`,
      [input.teamId, input.resourceType, input.resourceId, input.alertKey],
    );
    const current = rows[0];

    if (input.active) {
      const cooldownMs = Number(settings?.cooldownMinutes ?? 30) * 60_000;
      shouldNotify =
        !current ||
        !current.active ||
        !current.lastNotifiedAt ||
        Date.now() - current.lastNotifiedAt.getTime() >= cooldownMs;
      if (!current) {
        await connection.execute(
          `INSERT INTO monitoring_alerts
           (id,team_id,resource_type,resource_id,alert_key,event_type,severity,title,message,last_notified_at)
           VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,UUID_TO_BIN(?),?,?,?,?,?,?)`,
          [
            randomUUID(),
            input.teamId,
            input.resourceType,
            input.resourceId,
            input.alertKey,
            input.eventType,
            input.severity,
            input.title,
            input.message,
            shouldNotify ? new Date() : null,
          ],
        );
      } else {
        await connection.execute(
          `UPDATE monitoring_alerts SET event_type=?,severity=?,title=?,message=?,active=TRUE,
             occurrence_count=occurrence_count+1,
             first_triggered_at=IF(active,first_triggered_at,CURRENT_TIMESTAMP(3)),
             last_seen_at=CURRENT_TIMESTAMP(3),resolved_at=NULL,
             last_notified_at=IF(?,CURRENT_TIMESTAMP(3),last_notified_at)
           WHERE id=UUID_TO_BIN(?)`,
          [
            input.eventType,
            input.severity,
            input.title,
            input.message,
            shouldNotify,
            current.id,
          ],
        );
      }
    } else {
      if (!current?.active) {
        await connection.commit();
        return;
      }
      shouldNotify = Boolean(settings?.notifyRecovery ?? true);
      await connection.execute(
        `UPDATE monitoring_alerts SET active=FALSE,last_seen_at=CURRENT_TIMESTAMP(3),
           resolved_at=CURRENT_TIMESTAMP(3),last_notified_at=IF(?,CURRENT_TIMESTAMP(3),last_notified_at)
         WHERE id=UUID_TO_BIN(?)`,
        [shouldNotify, current.id],
      );
    }

    if (shouldNotify && (settings?.panelEnabled ?? true)) {
      const title = state === "resolved" ? `${input.resourceName} recovered` : input.title;
      const message = state === "resolved" ? input.recoveryMessage : input.message;
      await connection.execute(
        `INSERT INTO notifications
         (id,team_id,notification_type,severity,title,message,resource_type,resource_id)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?)`,
        [
          randomUUID(),
          input.teamId,
          `${input.eventType}_${state}`,
          state === "resolved" ? "info" : input.severity,
          title,
          message,
          input.resourceType,
          input.resourceId,
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

  if (shouldNotify) {
    const title = state === "resolved" ? `${input.resourceName} recovered` : input.title;
    const message = state === "resolved" ? input.recoveryMessage : input.message;
    await dispatchExternal(settings, input, title, message, state);
  }
}
