import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, test } from "node:test";
import { SignJWT } from "jose";
import { buildApp } from "../src/app.js";
import { createOidcLogoutTokenVerifier } from "../src/shared/modules/auth/oidc-logout.service.js";

const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

after(async () => {
  await Promise.all(applications.map((app) => app.close()));
});

test("back-channel logout tokens require the SSO signature, audience, event, and no nonce", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "logout-test",
    use: "sig",
    alg: "ES256",
  };
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const issuer = "https://auth.legacyhosting.xyz";
  const audience = "lh-panel";
  const subject = randomUUID();
  const verifier = createOidcLogoutTokenVerifier({
    issuer,
    audience,
    jwksUrl: `http://127.0.0.1:${address.port}/jwks`,
  });
  const token = await new SignJWT({
    sub: subject,
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
  })
    .setProtectedHeader({ alg: "ES256", kid: "logout-test", typ: "logout+jwt" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setJti("logout-event-123456789")
    .sign(privateKey);

  try {
    assert.deepEqual(await verifier(token), {
      subject,
      eventId: "logout-event-123456789",
    });

    const tokenWithNonce = await new SignJWT({
      sub: subject,
      nonce: "not-allowed",
      events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    })
      .setProtectedHeader({ alg: "ES256", kid: "logout-test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setJti("logout-event-987654321")
      .sign(privateKey);
    await assert.rejects(verifier(tokenWithNonce), /invalid_logout_token/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("the back-channel endpoint accepts form posts without browser CSRF headers", async () => {
  let received = "";
  const app = await buildApp({
    auth: {
      oidcLogin: {
        begin: async () => ({ authorizationUrl: "https://auth.example/auth", expiresIn: 600 }),
        complete: async () => ({ userId: randomUUID(), returnUrl: "https://panel.example/" }),
        backchannel: async (token) => {
          received = token;
          return { replayed: false };
        },
      },
    },
  });
  applications.push(app);
  const logoutToken = "x".repeat(120);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/oidc/backchannel-logout",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ logout_token: logoutToken }).toString(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(received, logoutToken);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/v1/auth/oidc/backchannel-logout",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "logout_token=short",
  });
  assert.equal(invalid.statusCode, 400);
});
