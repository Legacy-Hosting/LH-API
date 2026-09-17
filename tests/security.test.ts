import assert from "node:assert/strict";
import { test } from "node:test";
import { createCsrfToken, verifyCsrfToken } from "../src/shared/security/csrf.js";
import {
  randomToken,
  safeTokenEqual,
  tokenHash,
} from "../src/shared/modules/auth/auth.crypto.js";

test("CSRF tokens are session-bound and timing-safe", () => {
  const secret = "a".repeat(32);
  const token = createCsrfToken("session-a", secret);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(verifyCsrfToken("session-a", token, secret), true);
  assert.equal(verifyCsrfToken("session-b", token, secret), false);
  assert.equal(verifyCsrfToken("session-a", "not-a-token", secret), false);
});

test("opaque tokens have entropy and compare through hashes", () => {
  const first = randomToken(32);
  const second = randomToken(32);
  assert.notEqual(first, second);
  assert.equal(tokenHash(first).length, 32);
  assert.equal(safeTokenEqual(first, first), true);
  assert.equal(safeTokenEqual(first, second), false);
});
