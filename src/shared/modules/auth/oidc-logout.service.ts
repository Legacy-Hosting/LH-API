import type { ResultSetHeader } from "mysql2";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";
import { tokenHash } from "./auth.crypto.js";

const logoutEvent = "http://schemas.openid.net/event/backchannel-logout";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OidcLogoutIdentity = {
  subject: string;
  eventId: string;
};

export type OidcLogoutTokenVerifier = (
  token: string,
) => Promise<OidcLogoutIdentity>;

export function createOidcLogoutTokenVerifier(options: {
  issuer: string;
  audience: string;
  jwksUrl: string;
}): OidcLogoutTokenVerifier {
  const keySet = createRemoteJWKSet(new URL(options.jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ["ES256"],
      maxTokenAge: "2 minutes",
      clockTolerance: 5,
    });
    const events = payload.events;
    if (
      !events ||
      typeof events !== "object" ||
      Array.isArray(events) ||
      !(logoutEvent in events) ||
      "nonce" in payload ||
      typeof payload.sub !== "string" ||
      !uuidPattern.test(payload.sub) ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 16 ||
      payload.jti.length > 255
    ) {
      throw new Error("invalid_logout_token");
    }
    return { subject: payload.sub, eventId: payload.jti };
  };
}

let verifier: OidcLogoutTokenVerifier | undefined;

function productionVerifier() {
  if (!verifier) {
    if (!env.SSO_ISSUER || !env.SSO_CLIENT_ID || !env.SSO_JWKS_URL) {
      throw new Error("sso_not_configured");
    }
    verifier = createOidcLogoutTokenVerifier({
      issuer: env.SSO_ISSUER,
      audience: env.SSO_CLIENT_ID,
      jwksUrl: env.SSO_JWKS_URL,
    });
  }
  return verifier;
}

export async function revokeOidcSessions(
  logoutToken: string,
  verify: OidcLogoutTokenVerifier = productionVerifier(),
) {
  const identity = await verify(logoutToken);
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "DELETE FROM oidc_logout_events WHERE expires_at<=UTC_TIMESTAMP(3) LIMIT 1000",
    );
    const [recorded] = await connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO oidc_logout_events
         (jti_hash,subject,expires_at)
       VALUES (?,UUID_TO_BIN(?),TIMESTAMPADD(MINUTE,5,UTC_TIMESTAMP(3)))`,
      [tokenHash(identity.eventId), identity.subject],
    );
    if (recorded.affectedRows === 1) {
      await connection.execute(
        `UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(3)
         WHERE user_id=UUID_TO_BIN(?) AND revoked_at IS NULL`,
        [identity.subject],
      );
    }
    await connection.commit();
    return { replayed: recorded.affectedRows === 0 };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
