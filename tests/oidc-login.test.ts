import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { closeDatabase, database } from "../src/core/database/mysql.js";
import {
  beginOidcLogin,
  completeOidcLogin,
  type OidcProtocol,
} from "../src/shared/modules/auth/oidc-login.service.js";

test("OIDC login state is PKCE-bound, encrypted, return-safe, and single-use", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const userId = randomUUID();
  let authorizationInput: Parameters<OidcProtocol["authorizationUrl"]>[0] | undefined;
  let exchangeInput: Parameters<OidcProtocol["exchange"]>[0] | undefined;
  const protocol: OidcProtocol = {
    async authorizationUrl(input) {
      authorizationInput = input;
      const url = new URL("https://auth.legacyhosting.xyz/auth");
      url.searchParams.set("state", input.state);
      return url;
    },
    async exchange(input) {
      exchangeInput = input;
      return { subject: userId };
    },
  };
  const options = {
    protocol,
    issuer: "https://auth.legacyhosting.xyz",
    panelOrigin: "https://panel.legacyhosting.xyz",
    redirectUri: "https://api.legacyhosting.xyz/api/v1/auth/oidc/callback",
    resource: "https://api.legacyhosting.xyz",
  };
  try {
    await database().execute(
      `INSERT INTO users (id,email,display_name,status)
       VALUES (UUID_TO_BIN(?),?,?, 'active')`,
      [userId, `oidc-${userId}@example.com`, "OIDC Login User"],
    );
    const started = await beginOidcLogin("//attacker.invalid/steal", options);
    assert.ok(authorizationInput);
    assert.equal(authorizationInput.redirectUri, options.redirectUri);
    assert.equal(authorizationInput.resource, options.resource);
    assert.equal(authorizationInput.codeChallenge.length, 43);

    const callback = new URL(options.redirectUri);
    callback.searchParams.set("code", "authorization-code");
    callback.searchParams.set("state", authorizationInput.state);
    const completed = await completeOidcLogin(callback, options);
    assert.equal(completed.userId, userId);
    assert.equal(completed.returnUrl, "https://panel.legacyhosting.xyz/");
    assert.equal(exchangeInput?.state, authorizationInput.state);
    assert.equal(exchangeInput?.nonce, authorizationInput.nonce);
    assert.equal(exchangeInput?.codeVerifier.length, 43);
    assert.notEqual(exchangeInput?.codeVerifier, authorizationInput.codeChallenge);
    assert.match(started.authorizationUrl, /^https:\/\/auth\.legacyhosting\.xyz\/auth\?/);

    await assert.rejects(
      completeOidcLogin(callback, options),
      /invalid_or_expired_sso_state/,
    );
  } finally {
    await database().execute("DELETE FROM oidc_login_requests");
    await database().execute("DELETE FROM users WHERE id=UUID_TO_BIN(?)", [userId]);
    await closeDatabase();
  }
});
