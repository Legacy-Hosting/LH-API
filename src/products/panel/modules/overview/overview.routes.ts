import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";

export const overviewRoutes: FastifyPluginAsync = async (app) => {
  app.get("/overview", async (request) => {
    const team = teamFrom(request);
    const user = (request as FastifyRequest & { sessionUser: SessionUser })
      .sessionUser;
    const [applications, domains, deployments] = await Promise.all([
      database().query<(RowDataPacket & { total: number; running: number })[]>(
        "SELECT COUNT(*) AS total,COALESCE(SUM(status='running'),0) AS running FROM applications WHERE team_id=UUID_TO_BIN(?)",
        [team.id],
      ),
      database().query<(RowDataPacket & { total: number; proxied: number })[]>(
        "SELECT COUNT(*) AS total,COALESCE(SUM(proxied=TRUE),0) AS proxied FROM domains WHERE team_id=UUID_TO_BIN(?)",
        [team.id],
      ),
      database().query<(RowDataPacket & { total: number })[]>(
        `SELECT COUNT(*) AS total FROM deployments d JOIN applications a ON a.id=d.application_id
         WHERE a.team_id=UUID_TO_BIN(?) AND d.created_at>=DATE_FORMAT(CURRENT_TIMESTAMP,'%Y-%m-01')`,
        [team.id],
      ),
    ]);

    const appStats = applications[0][0];
    let nodeStats = { total: 0, online: 0 };
    if (user.isPlatformAdmin) {
      const [nodes] = await database().query<
        (RowDataPacket & { total: number; online: number })[]
      >(
        "SELECT COUNT(*) AS total,COALESCE(SUM(status='online'),0) AS online FROM nodes",
      );
      nodeStats = {
        total: Number(nodes[0]?.total ?? 0),
        online: Number(nodes[0]?.online ?? 0),
      };
    }
    const domainStats = domains[0][0];
    return {
      data: {
        stats: {
          applications: Number(appStats?.total ?? 0),
          runningApplications: Number(appStats?.running ?? 0),
          nodes: nodeStats.total,
          onlineNodes: nodeStats.online,
          domains: Number(domainStats?.total ?? 0),
          proxiedDomains: Number(domainStats?.proxied ?? 0),
          deploymentsThisMonth: Number(deployments[0][0]?.total ?? 0),
        },
        systemStatus:
          nodeStats.total === nodeStats.online
            ? "operational"
            : "degraded",
      },
      meta: { team },
    };
  });
};
