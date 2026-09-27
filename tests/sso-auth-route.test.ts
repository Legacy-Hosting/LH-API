import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

process.env.SSO_INTERNAL_URL = "https://sso.internal.example";
process.env.SSO_ISSUER = "https://auth.legacyhosting.xyz";
process.env.SSO_IDENTITY_BRIDGE_TOKEN = "b".repeat(32);

const { buildApp } = await import("../src/app.js");
const { closeDatabase, database } = await import("../src/core/database/mysql.js");
const { createCsrfToken } = await import("../src/shared/security/csrf.js");
const { tokenHash } = await import("../src/shared/modules/auth/auth.crypto.js");

test("an authenticated Panel session can continue its SSO interaction", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  const userId = randomUUID();
  const sessionToken = "legacy-session-token";
  const interactionUid = "interaction_uid_123456";
  let bridgeRequest: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    bridgeRequest = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      data: {
        ticket: "t".repeat(43),
        expiresIn: 60,
        completionUri: `https://auth.legacyhosting.xyz/interaction/${interactionUid}/complete`,
      },
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    await database().execute(
      `INSERT INTO users (id,email,display_name,status)
       VALUES (UUID_TO_BIN(?),'sso-route@example.com','SSO Route User','active')`,
      [userId],
    );
    await database().execute(
      `INSERT INTO user_sessions (id,user_id,token_hash,expires_at)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,TIMESTAMPADD(HOUR,1,UTC_TIMESTAMP(3)))`,
      [randomUUID(), userId, tokenHash(sessionToken)],
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sso/continue",
      headers: {
        origin: "http://localhost:5173",
        cookie: `lh_session=${sessionToken}`,
        "x-csrf-token": createCsrfToken(sessionToken),
      },
      payload: { interactionUid },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(bridgeRequest, {
      interactionUid,
      subject: userId,
      email: "sso-route@example.com",
      displayName: "SSO Route User",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await database().execute("DELETE FROM users WHERE id=UUID_TO_BIN(?)", [userId]);
    await app.close();
    await closeDatabase();
  }
});
