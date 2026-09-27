import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

process.env.SSO_INTERNAL_URL = "https://sso.internal.example";
process.env.SSO_ISSUER = "https://auth.legacyhosting.xyz";
process.env.SSO_IDENTITY_BRIDGE_TOKEN = "b".repeat(32);
process.env.SSO_REDIRECT_URI = "https://api.legacyhosting.xyz/api/v1/auth/oidc/callback";
process.env.SSO_RESOURCE = "https://api.legacyhosting.xyz";

const { buildApp } = await import("../src/app.js");
const { closeDatabase, database } = await import("../src/core/database/mysql.js");
const { createCsrfToken } = await import("../src/shared/security/csrf.js");
const { tokenHash } = await import("../src/shared/modules/auth/auth.crypto.js");

test("Panel can start an OIDC login without exposing the client secret", async () => {
  const app = await buildApp({
    auth: {
      oidcLogin: {
        begin: async (returnTo) => ({
          authorizationUrl: `https://auth.legacyhosting.xyz/auth?return_to=${encodeURIComponent(returnTo ?? "")}`,
          expiresIn: 600,
        }),
        complete: async () => ({
          userId: "123e4567-e89b-12d3-a456-426614174000",
          returnUrl: "http://localhost:5173/",
        }),
      },
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/start?return_to=%2Fapplications",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.json().data.authorizationUrl, /return_to=%2Fapplications/);
    assert.doesNotMatch(response.body, /client_secret/i);
  } finally {
    await app.close();
  }
});

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

test("the OIDC callback creates an HttpOnly Panel session and redirects safely", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const userId = randomUUID();
  const app = await buildApp({
    auth: {
      oidcLogin: {
        begin: async () => ({
          authorizationUrl: "https://auth.legacyhosting.xyz/auth",
          expiresIn: 600,
        }),
        complete: async () => ({
          userId,
          returnUrl: "http://localhost:5173/applications",
        }),
      },
    },
  });
  try {
    await database().execute(
      `INSERT INTO users (id,email,display_name,status)
       VALUES (UUID_TO_BIN(?),?,?, 'active')`,
      [userId, `oidc-route-${userId}@example.com`, "OIDC Route User"],
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/oidc/callback?code=authorization-code&state=s".concat("s".repeat(42)),
    });
    assert.equal(response.statusCode, 302, response.body);
    assert.equal(response.headers.location, "http://localhost:5173/applications");
    assert.match(String(response.headers["set-cookie"]), /lh_session=/);
    assert.match(String(response.headers["set-cookie"]), /HttpOnly/i);
  } finally {
    await database().execute("DELETE FROM users WHERE id=UUID_TO_BIN(?)", [userId]);
    await app.close();
    await closeDatabase();
  }
});
