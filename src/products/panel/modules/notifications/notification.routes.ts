import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";

const notificationParams = z.object({ notificationId: z.string().uuid() });

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/notifications", async (request) => {
    const team = teamFrom(request);
    const user = (request as FastifyRequest & { sessionUser: SessionUser })
      .sessionUser;
    const [notifications, counts] = await Promise.all([
      database().query<
        (RowDataPacket & {
          id: string;
          type: string;
          severity: string;
          title: string;
          message: string;
          resourceType: string | null;
          resourceId: string | null;
          createdAt: Date;
          readAt: Date | null;
        })[]
      >(
        `SELECT BIN_TO_UUID(n.id) AS id,n.notification_type AS type,n.severity,n.title,n.message,
                n.resource_type AS resourceType,n.resource_id AS resourceId,n.created_at AS createdAt,r.read_at AS readAt
         FROM notifications n LEFT JOIN notification_reads r
           ON r.notification_id=n.id AND r.user_id=UUID_TO_BIN(?)
         WHERE n.team_id=UUID_TO_BIN(?) ORDER BY n.created_at DESC LIMIT 50`,
        [user.id, team.id],
      ),
      database().query<(RowDataPacket & { unread: number })[]>(
        `SELECT COUNT(*) AS unread FROM notifications n LEFT JOIN notification_reads r
           ON r.notification_id=n.id AND r.user_id=UUID_TO_BIN(?)
         WHERE n.team_id=UUID_TO_BIN(?) AND r.notification_id IS NULL`,
        [user.id, team.id],
      ),
    ]);
    return {
      data: notifications[0],
      meta: { unread: Number(counts[0][0]?.unread ?? 0) },
    };
  });

  app.post(
    "/notifications/:notificationId/read",
    async (request, reply) => {
      const params = notificationParams.safeParse(request.params);
      if (!params.success)
        return reply.status(400).send({ error: "validation_error" });
      const team = teamFrom(request);
      const user = (request as FastifyRequest & { sessionUser: SessionUser })
        .sessionUser;
      await database().execute(
        `INSERT INTO notification_reads (notification_id,user_id)
         SELECT n.id,UUID_TO_BIN(?) FROM notifications n
         WHERE n.id=UUID_TO_BIN(?) AND n.team_id=UUID_TO_BIN(?)
         ON DUPLICATE KEY UPDATE read_at=CURRENT_TIMESTAMP(3)`,
        [user.id, params.data.notificationId, team.id],
      );
      return { data: { read: true } };
    },
  );

  app.post("/notifications/read-all", async (request) => {
    const team = teamFrom(request);
    const user = (request as FastifyRequest & { sessionUser: SessionUser })
      .sessionUser;
    await database().execute(
      `INSERT IGNORE INTO notification_reads (notification_id,user_id)
       SELECT id,UUID_TO_BIN(?) FROM notifications WHERE team_id=UUID_TO_BIN(?)`,
      [user.id, team.id],
    );
    return { data: { read: true } };
  });
};
