import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RowDataPacket } from "mysql2";
import { database } from "../../../../core/database/mysql.js";
import type { SessionUser } from "../../../../shared/modules/auth/auth.types.js";
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
       LEFT JOIN application_domains ad ON ad.domain_id=d.id
       LEFT JOIN applications a ON a.id=ad.application_id
       LEFT JOIN nodes n ON n.id=a.node_id
       WHERE d.team_id=UUID_TO_BIN(?) ORDER BY d.hostname`,
      [team.id],
    );
    const user = (request as FastifyRequest & { sessionUser: SessionUser })
      .sessionUser;
    return {
      data: domains.map((domain) => ({
        ...domain,
        dnsTarget: user.isPlatformAdmin ? domain.dnsTarget : undefined,
        nodeName: user.isPlatformAdmin ? domain.nodeName : undefined,
        proxied: Boolean(domain.proxied),
      })),
      meta: { team, cnameTargetManagedByNode: true },
    };
  });
};
