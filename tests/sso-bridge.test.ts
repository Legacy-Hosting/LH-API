import assert from "node:assert/strict";
import { test } from "node:test";
import { createSsoLoginTicket } from "../src/shared/modules/auth/sso-bridge.service.js";

const interactionUid = "interaction_uid_123456";
const input = {
  interactionUid,
  subject: "123e4567-e89b-12d3-a456-426614174000",
  email: "user@example.com",
  displayName: "Example User",
};

test("the API requests a login ticket server-to-server and validates its completion URI", async () => {
  let receivedAuthorization = "";
  let receivedBody = "";
  const ticket = await createSsoLoginTicket(input, {
    internalUrl: "https://sso.internal.example",
    issuer: "https://auth.legacyhosting.xyz",
    token: "b".repeat(32),
    fetchImplementation: async (_url, init) => {
      receivedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      receivedBody = String(init?.body);
      return new Response(JSON.stringify({
        data: {
          ticket: "t".repeat(43),
          expiresIn: 60,
          completionUri: `https://auth.legacyhosting.xyz/interaction/${interactionUid}/complete`,
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(receivedAuthorization, `Bearer ${"b".repeat(32)}`);
  assert.deepEqual(JSON.parse(receivedBody), input);
  assert.equal(ticket.ticket, "t".repeat(43));
});

test("the API rejects a completion URI outside the configured issuer", async () => {
  await assert.rejects(
    createSsoLoginTicket(input, {
      internalUrl: "https://sso.internal.example",
      issuer: "https://auth.legacyhosting.xyz",
      token: "b".repeat(32),
      fetchImplementation: async () => new Response(JSON.stringify({
        data: {
          ticket: "t".repeat(43),
          expiresIn: 60,
          completionUri: `https://attacker.invalid/interaction/${interactionUid}/complete`,
        },
      }), { status: 201, headers: { "content-type": "application/json" } }),
    }),
    /invalid_sso_response/,
  );
});

test("the API maps SSO identity conflicts without retrying in the browser", async () => {
  await assert.rejects(
    createSsoLoginTicket(input, {
      internalUrl: "https://sso.internal.example",
      issuer: "https://auth.legacyhosting.xyz",
      token: "b".repeat(32),
      fetchImplementation: async () => new Response(null, { status: 409 }),
    }),
    (error: unknown) => error instanceof Error && error.message === "sso_identity_conflict",
  );
});
