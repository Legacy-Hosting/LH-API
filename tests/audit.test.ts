import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import Fastify from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  auditRoutes,
  createHubAuditTokenVerifier,
} from "../src/shared/modules/audit/audit.routes.js";
import {
  decodeAuditCursor,
  encodeAuditCursor,
  sanitizeAuditMetadata,
} from "../src/shared/modules/audit/audit.service.js";

test("audit metadata recursively redacts secret-like values", () => {
  assert.deepEqual(
    sanitizeAuditMetadata({
      hostname: "panel.legacyhosting.xyz",
      token: "never-return-this",
      nested: { password: "hidden", status: "queued" },
    }),
    {
      hostname: "panel.legacyhosting.xyz",
      token: "[redacted]",
      nested: { password: "[redacted]", status: "queued" },
    },
  );
});

test("audit cursors are opaque, round-trip safely, and reject invalid data", () => {
  const cursor = { createdAt: "2026-09-27T12:30:00.000Z", id: "912" };
  assert.deepEqual(decodeAuditCursor(encodeAuditCursor(cursor)), cursor);
  assert.equal(decodeAuditCursor("not-a-cursor"), null);
});

test("Hub audit endpoint requires an allowed staff role and validates cursors", async () => {
  const app = Fastify();
  await app.register(auditRoutes, {
    internalToken: "h".repeat(32),
    tokenVerifier: async (token) => ({
      sub: "staff-1",
      roles: token === "support-token" ? ["support"] : ["developer"],
    }),
    reader: async (query) => ({
      events: [],
      nextCursor: query.limit === 25 ? null : "unexpected",
    }),
  });
  try {
    const missing = await app.inject({ method: "GET", url: "/audit-events" });
    assert.equal(missing.statusCode, 401);

    const denied = await app.inject({
      method: "GET",
      url: "/audit-events",
      headers: { authorization: "Bearer developer-token" },
    });
    assert.equal(denied.statusCode, 403);

    const invalidCursor = await app.inject({
      method: "GET",
      url: "/audit-events?cursor=invalid",
      headers: { authorization: "Bearer support-token" },
    });
    assert.equal(invalidCursor.statusCode, 400);

    const allowed = await app.inject({
      method: "GET",
      url: "/audit-events?limit=25",
      headers: { authorization: "Bearer support-token" },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json(), {
      data: { events: [], nextCursor: null },
    });

    const internal = await app.inject({
      method: "GET",
      url: "/audit-events?limit=25",
      headers: { "x-lh-hub-token": "h".repeat(32) },
    });
    assert.equal(internal.statusCode, 200);
    assert.deepEqual(internal.json(), { data: { events: [], nextCursor: null } });
  } finally {
    await app.close();
  }
});

test("Hub audit verifier enforces issuer, audience, signature, and age", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  Object.assign(jwk, { kid: "audit-test", use: "sig", alg: "ES256" });
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const issuer = "https://auth.legacyhosting.xyz";
    const verifier = createHubAuditTokenVerifier({
      issuer,
      audience: "lh-hub",
      jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
    });
    const token = await new SignJWT({ sub: "staff-1", roles: ["support"] })
      .setProtectedHeader({ alg: "ES256", kid: "audit-test" })
      .setIssuer(issuer)
      .setAudience("lh-hub")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const claims = await verifier(token) as { sub: string };
    assert.equal(claims.sub, "staff-1");

    const wrongAudience = await new SignJWT({ sub: "staff-1", roles: ["support"] })
      .setProtectedHeader({ alg: "ES256", kid: "audit-test" })
      .setIssuer(issuer)
      .setAudience("lh-api")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    await assert.rejects(verifier(wrongAudience));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
