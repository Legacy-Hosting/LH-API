import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { env } from "../core/config/env.js";
import { closeDatabase, database } from "../core/database/mysql.js";

type CertificateCandidate = RowDataPacket & {
  applicationId: string;
  domainId: string;
  nodeId: string;
  teamId: string;
  hostname: string;
  certificateExpiresAt: Date | null;
};

async function queueCertificateWork() {
  const cutoff = new Date(
    Date.now() + env.CERTIFICATE_RENEWAL_DAYS * 24 * 60 * 60 * 1000,
  );
  const connection = await database().getConnection();
  let queued = 0;
  try {
    await connection.beginTransaction();
    const [candidates] = await connection.query<CertificateCandidate[]>(
      `SELECT BIN_TO_UUID(a.id) AS applicationId,BIN_TO_UUID(d.id) AS domainId,
              BIN_TO_UUID(a.node_id) AS nodeId,BIN_TO_UUID(a.team_id) AS teamId,
              d.hostname,d.certificate_expires_at AS certificateExpiresAt
       FROM domains d JOIN applications a ON a.domain_id=d.id
       WHERE a.deleted_at IS NULL AND d.status='active'
         AND d.proxy_status IN ('configuring','active','error')
         AND (d.certificate_expires_at IS NULL OR d.certificate_expires_at<=?)
         AND NOT EXISTS (
           SELECT 1 FROM node_commands c
           WHERE c.application_id=a.id
             AND c.command_type IN ('configure_proxy','renew_certificate')
             AND c.status IN ('queued','leased')
         )
       ORDER BY COALESCE(d.certificate_expires_at,'1970-01-01')
       LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [cutoff],
    );

    for (const candidate of candidates) {
      const commandType = candidate.certificateExpiresAt
        ? "renew_certificate"
        : "configure_proxy";
      await connection.execute(
        `INSERT INTO node_commands (id,node_id,application_id,command_type,payload)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),?,JSON_OBJECT())`,
        [
          randomUUID(),
          candidate.nodeId,
          candidate.applicationId,
          commandType,
        ],
      );
      await connection.execute(
        "UPDATE domains SET proxy_status='configuring',last_error=NULL WHERE id=UUID_TO_BIN(?)",
        [candidate.domainId],
      );
      await connection.execute(
        `INSERT INTO audit_events (team_id,product_key,action,resource_type,resource_id,metadata)
         VALUES (UUID_TO_BIN(?),'panel','certificate.queued','domain',?,?)`,
        [
          candidate.teamId,
          candidate.domainId,
          JSON.stringify({
            hostname: candidate.hostname,
            commandType,
            previousExpiration:
              candidate.certificateExpiresAt?.toISOString() ?? null,
          }),
        ],
      );
      queued += 1;
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  console.log(
    `${new Date().toISOString()} certificate scheduler queued ${queued} command(s)`,
  );
}

let running = false;
async function scan() {
  if (running) return;
  running = true;
  try {
    await queueCertificateWork();
  } catch (error) {
    console.error(
      `${new Date().toISOString()} certificate scheduler failed`,
      error instanceof Error ? error.message : error,
    );
  } finally {
    running = false;
  }
}

await scan();
const timer = setInterval(scan, 6 * 60 * 60 * 1000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    clearInterval(timer);
    await closeDatabase();
    process.exit(0);
  });
}
