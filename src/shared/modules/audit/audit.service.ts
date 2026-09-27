import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../core/database/mysql.js";

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().regex(/^\d+$/),
});

const sensitiveKey = /(authorization|cookie|credential|password|secret|token|private.?key|content)/i;

export type AuditCursor = z.infer<typeof cursorSchema>;
export type AuditQuery = {
  limit: number;
  cursor?: AuditCursor;
};

export type AuditEvent = {
  id: string;
  team: { id: string; name: string } | null;
  actor: { id: string; name: string; email: string } | null;
  product: string;
  action: string;
  resource: { type: string; id: string | null } | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type AuditRow = RowDataPacket & {
  id: string;
  teamId: string | null;
  teamName: string | null;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  product: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: unknown;
  createdAt: Date | string;
};

function safeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => safeMetadata(entry, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ? "[redacted]" : safeMetadata(entry, depth + 1),
      ]),
  );
}

export function sanitizeAuditMetadata(value: unknown) {
  if (value === null || value === undefined) return null;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return safeMetadata(parsed) as Record<string, unknown>;
}

export function encodeAuditCursor(cursor: AuditCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeAuditCursor(cursor: string): AuditCursor | null {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

export async function readAuditEvents(query: AuditQuery): Promise<{
  events: AuditEvent[];
  nextCursor: string | null;
}> {
  const parameters: Array<string | number | Date> = [];
  let where = "";
  if (query.cursor) {
    where = "WHERE (a.created_at < ? OR (a.created_at = ? AND a.id < ?))";
    parameters.push(
      new Date(query.cursor.createdAt),
      new Date(query.cursor.createdAt),
      query.cursor.id,
    );
  }
  parameters.push(query.limit + 1);
  const [rows] = await database().query<AuditRow[]>(
    `SELECT CAST(a.id AS CHAR) AS id,
            BIN_TO_UUID(a.team_id) AS teamId,t.name AS teamName,
            BIN_TO_UUID(a.user_id) AS actorId,u.display_name AS actorName,u.email AS actorEmail,
            a.product_key AS product,a.action,a.resource_type AS resourceType,
            a.resource_id AS resourceId,a.metadata,a.created_at AS createdAt
     FROM audit_events a
     LEFT JOIN teams t ON t.id=a.team_id
     LEFT JOIN users u ON u.id=a.user_id
     ${where}
     ORDER BY a.created_at DESC,a.id DESC
     LIMIT ?`,
    parameters,
  );
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const events = page.map((row): AuditEvent => ({
    id: row.id,
    team: row.teamId && row.teamName
      ? { id: row.teamId, name: row.teamName }
      : null,
    actor: row.actorId && row.actorName && row.actorEmail
      ? { id: row.actorId, name: row.actorName, email: row.actorEmail }
      : null,
    product: row.product,
    action: row.action,
    resource: row.resourceType
      ? { type: row.resourceType, id: row.resourceId }
      : null,
    metadata: sanitizeAuditMetadata(row.metadata),
    createdAt: new Date(row.createdAt).toISOString(),
  }));
  const last = hasMore ? events.at(-1) : undefined;
  return {
    events,
    nextCursor: last
      ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
      : null,
  };
}
