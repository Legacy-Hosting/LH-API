import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";

const restorableStatuses = new Set(["pending", "running", "stopped", "failed"]);

function parsePayload(value: string | Record<string, unknown>) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function cancelDeployment(
  deploymentId: string,
  teamId: string,
  user: SessionUser,
) {
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<
      (RowDataPacket & {
        applicationId: string;
        applicationName: string;
        deploymentStatus: string;
        commandId: string | null;
        commandStatus: string | null;
        payload: string | Record<string, unknown> | null;
      })[]
    >(
      `SELECT BIN_TO_UUID(a.id) AS applicationId,a.name AS applicationName,d.status AS deploymentStatus,
              BIN_TO_UUID(c.id) AS commandId,c.status AS commandStatus,c.payload
       FROM deployments d JOIN applications a ON a.id=d.application_id
       LEFT JOIN node_commands c ON c.deployment_id=d.id
       WHERE d.id=UUID_TO_BIN(?) AND a.team_id=UUID_TO_BIN(?) FOR UPDATE`,
      [deploymentId, teamId],
    );
    const deployment = rows[0];
    if (!deployment) throw new Error("deployment_not_found");
    if (
      !deployment.commandId ||
      !deployment.commandStatus ||
      !["queued", "leased"].includes(deployment.commandStatus)
    ) {
      throw new Error("deployment_not_cancellable");
    }

    const payload = parsePayload(deployment.payload ?? {});
    const requestedPrevious = payload.previousApplicationStatus;
    const previousStatus =
      typeof requestedPrevious === "string" &&
      restorableStatuses.has(requestedPrevious)
        ? requestedPrevious
        : "failed";
    const cancellationState =
      deployment.commandStatus === "queued" ? "cancelled" : "requested";

    if (deployment.commandStatus === "queued") {
      await connection.execute(
        `UPDATE node_commands SET status='cancelled',cancel_requested_at=CURRENT_TIMESTAMP(3),
           finished_at=CURRENT_TIMESTAMP(3),output='Cancelled before execution' WHERE id=UUID_TO_BIN(?)`,
        [deployment.commandId],
      );
      await connection.execute(
        `UPDATE deployments SET status='cancelled',finished_at=CURRENT_TIMESTAMP(3) WHERE id=UUID_TO_BIN(?)`,
        [deploymentId],
      );
      await connection.execute(
        "UPDATE applications SET status=? WHERE id=UUID_TO_BIN(?)",
        [previousStatus, deployment.applicationId],
      );
      await connection.execute(
        `INSERT INTO notifications
         (id,team_id,notification_type,severity,title,message,resource_type,resource_id)
         VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'deployment_cancelled','info',?,?,'deployment',?)`,
        [
          randomUUID(),
          teamId,
          `${deployment.applicationName} deployment cancelled`,
          "The deployment was cancelled before the node started it.",
          deploymentId,
        ],
      );
    } else {
      await connection.execute(
        "UPDATE node_commands SET cancel_requested_at=CURRENT_TIMESTAMP(3) WHERE id=UUID_TO_BIN(?)",
        [deployment.commandId],
      );
    }

    await connection.execute(
      `INSERT INTO audit_events
       (team_id,user_id,product_key,action,resource_type,resource_id,metadata)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'panel','deployment.cancel_requested','deployment',?,?)`,
      [
        teamId,
        user.id,
        deploymentId,
        JSON.stringify({ commandId: deployment.commandId, cancellationState }),
      ],
    );
    await connection.commit();
    return { deploymentId, commandId: deployment.commandId, cancellationState };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
