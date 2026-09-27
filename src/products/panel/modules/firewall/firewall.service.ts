import { isIP } from "node:net";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { database } from "../../../../core/database/mysql.js";

const privateIpv4Ranges: Array<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 3],
];

function ipv4Number(value: string) {
  return value
    .split(".")
    .map(Number)
    .reduce((result, octet) => (result * 256 + octet) >>> 0, 0);
}

function privateIpv4(value: string) {
  const address = ipv4Number(value);
  return privateIpv4Ranges.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((address & mask) >>> 0) === ((network & mask) >>> 0);
  });
}

function privateIpv6(value: string) {
  const address = value.toLowerCase();
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("::ffff:") ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    address.startsWith("2001:db8:")
  );
}

export function normalizePublicIpAddress(value: string) {
  const candidate = value.trim().toLowerCase();
  const family = isIP(candidate);
  if (family === 4) {
    if (privateIpv4(candidate)) return null;
    return candidate.split(".").map(Number).join(".");
  }
  if (family === 6) {
    if (privateIpv6(candidate)) return null;
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.slice(1, -1);
  }
  return null;
}

export const firewallBanReportSchema = z.object({
  ipAddress: z
    .string()
    .max(45)
    .refine((value) => normalizePublicIpAddress(value) !== null, {
      message: "Only public IPv4 or IPv6 addresses can be shared",
    }),
  jail: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_.-]+$/),
});

export type FirewallBanReport = z.infer<typeof firewallBanReportSchema>;

type ExistingBan = RowDataPacket & {
  ipAddress: string;
  active: number;
  suppressionActive: number;
};

async function auditActivation(
  connection: PoolConnection,
  nodeId: string,
  ipAddress: string,
  jail: string,
) {
  await connection.execute(
    `INSERT INTO audit_events
     (team_id,product_key,action,resource_type,resource_id,metadata)
     SELECT n.team_id,'panel','firewall.ban.activated','ip_address',?,
            JSON_OBJECT('nodeId',?,'jail',?)
     FROM nodes n WHERE n.id=UUID_TO_BIN(?)`,
    [ipAddress, nodeId, jail, nodeId],
  );
}

export async function recordGlobalFirewallBans(
  connection: PoolConnection,
  nodeId: string,
  reports: FirewallBanReport[],
) {
  const unique = new Map<string, string>();
  for (const report of reports) {
    const ipAddress = normalizePublicIpAddress(report.ipAddress);
    if (ipAddress) unique.set(ipAddress, report.jail);
  }
  const entries = [...unique].sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) return;

  const ipAddresses = entries.map(([ipAddress]) => ipAddress);
  const [existingRows] = await connection.query<ExistingBan[]>(
    `SELECT ip_address AS ipAddress,active,
            suppressed_until>CURRENT_TIMESTAMP(3) AS suppressionActive
     FROM global_firewall_bans
     WHERE ip_address IN (${ipAddresses.map(() => "?").join(",")})
     ORDER BY ip_address FOR UPDATE`,
    ipAddresses,
  );
  const existingByAddress = new Map(
    existingRows.map((row) => [row.ipAddress, row]),
  );

  for (const [ipAddress, jail] of entries) {
    const existing = existingByAddress.get(ipAddress);
    if (!existing) {
      await connection.execute(
        `INSERT INTO global_firewall_bans
         (ip_address,address_family,source_node_id,source_jail,reason)
         VALUES (?, ?, UUID_TO_BIN(?), ?, ?)`,
        [
          ipAddress,
          isIP(ipAddress) === 4 ? "ipv4" : "ipv6",
          nodeId,
          jail,
          `Fail2Ban ${jail} ban`,
        ],
      );
      await auditActivation(connection, nodeId, ipAddress, jail);
      continue;
    }

    const suppressionActive = Boolean(existing.suppressionActive);
    if (!existing.active && !suppressionActive) {
      await connection.execute(
        `UPDATE global_firewall_bans
         SET active=TRUE,source_node_id=UUID_TO_BIN(?),source_jail=?,reason=?,
             activation_count=activation_count+1,last_reported_at=CURRENT_TIMESTAMP(3),
             removed_at=NULL,removed_by=NULL,removal_reason=NULL,suppressed_until=NULL
         WHERE ip_address=?`,
        [nodeId, jail, `Fail2Ban ${jail} ban`, ipAddress],
      );
      await auditActivation(connection, nodeId, ipAddress, jail);
    }
  }

  await connection.query(
    `UPDATE global_firewall_bans
     SET last_reported_at=CURRENT_TIMESTAMP(3)
     WHERE active=TRUE AND last_reported_at<CURRENT_TIMESTAMP(3)-INTERVAL 5 MINUTE
       AND ip_address IN (${ipAddresses.map(() => "?").join(",")})`,
    ipAddresses,
  );
}

export async function readGlobalFirewallPolicy() {
  const [active, suppressed] = await Promise.all([
    database().query<(RowDataPacket & { ipAddress: string })[]>(
      `SELECT ip_address AS ipAddress FROM global_firewall_bans
       WHERE active=TRUE ORDER BY ip_address`,
    ),
    database().query<(RowDataPacket & { ipAddress: string })[]>(
      `SELECT ip_address AS ipAddress FROM global_firewall_bans
       WHERE active=FALSE AND suppressed_until>CURRENT_TIMESTAMP(3)
       ORDER BY ip_address`,
    ),
  ]);
  return {
    activeIps: active[0].map((row) => row.ipAddress),
    unbanIps: suppressed[0].map((row) => row.ipAddress),
  };
}

export async function listGlobalFirewallBans() {
  const [rows] = await database().query<
    (RowDataPacket & {
      ipAddress: string;
      addressFamily: "ipv4" | "ipv6";
      active: number;
      sourceNodeId: string | null;
      sourceNodeName: string | null;
      sourceJail: string;
      reason: string;
      activationCount: number;
      firstReportedAt: Date;
      lastReportedAt: Date;
      removedAt: Date | null;
      removalReason: string | null;
    })[]
  >(
    `SELECT b.ip_address AS ipAddress,b.address_family AS addressFamily,
            b.active,BIN_TO_UUID(b.source_node_id) AS sourceNodeId,
            n.name AS sourceNodeName,b.source_jail AS sourceJail,b.reason,
            b.activation_count AS activationCount,
            b.first_reported_at AS firstReportedAt,
            b.last_reported_at AS lastReportedAt,b.removed_at AS removedAt,
            b.removal_reason AS removalReason
     FROM global_firewall_bans b
     LEFT JOIN nodes n ON n.id=b.source_node_id
     ORDER BY b.active DESC,b.last_reported_at DESC
     LIMIT 1000`,
  );
  return rows.map((row) => ({
    ...row,
    active: Boolean(row.active),
    firstReportedAt: row.firstReportedAt.toISOString(),
    lastReportedAt: row.lastReportedAt.toISOString(),
    removedAt: row.removedAt?.toISOString() ?? null,
  }));
}

export async function removeGlobalFirewallBan(input: {
  ipAddress: string;
  reason: string;
  userId: string;
  teamId: string;
}) {
  const ipAddress = normalizePublicIpAddress(input.ipAddress);
  if (!ipAddress) return false;
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `UPDATE global_firewall_bans
       SET active=FALSE,removed_at=CURRENT_TIMESTAMP(3),removed_by=UUID_TO_BIN(?),
           removal_reason=?,suppressed_until=CURRENT_TIMESTAMP(3)+INTERVAL 25 HOUR
       WHERE ip_address=? AND active=TRUE`,
      [input.userId, input.reason, ipAddress],
    );
    if (!(result as { affectedRows: number }).affectedRows) {
      await connection.rollback();
      return false;
    }
    await connection.execute(
      `INSERT INTO audit_events
       (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','firewall.ban.removed','ip_address',?,
               JSON_OBJECT('reason',?))`,
      [input.teamId, input.userId, ipAddress, input.reason],
    );
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
