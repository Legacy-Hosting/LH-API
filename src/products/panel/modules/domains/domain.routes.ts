import type { FastifyPluginAsync } from "fastify";
import type { RowDataPacket } from "mysql2";
import { database } from "../../../../core/database/mysql.js";
import { teamFrom } from "../../../../shared/modules/teams/team.context.js";

export const domainRoutes: FastifyPluginAsync = async (app) => {
  app.get("/domains", async (request) => {
    const team = teamFrom(request);
    const [domains] = await database().query<
      (RowDataPacket & {
        id: string;
        hostname: string;
        rootDomain: string;
        recordType: string;
        dnsTarget: string;
        proxied: number;
        status: string;
        proxyStatus: string;
        certificateRenewedAt: Date | null;
        certificateExpiresAt: Date | null;
        lastError: string | null;
        nodeName: string | null;
      })[]
    >(
      `SELECT BIN_TO_UUID(d.id) AS id,d.hostname,d.root_domain AS rootDomain,d.record_type AS recordType,
              d.dns_target AS dnsTarget,d.proxied,d.status,d.proxy_status AS proxyStatus,
              d.certificate_renewed_at AS certificateRenewedAt,d.certificate_expires_at AS certificateExpiresAt,
              d.last_error AS lastError,n.name AS nodeName
       FROM domains d
       LEFT JOIN applications a ON a.domain_id=d.id
       LEFT JOIN nodes n ON n.id=a.node_id
       WHERE d.team_id=UUID_TO_BIN(?) ORDER BY d.hostname`,
      [team.id],
    );
    return {
      data: domains.map((domain) => ({
        ...domain,
        proxied: Boolean(domain.proxied),
      })),
      meta: { team, cnameTargetManagedByNode: true },
    };
  });
};
