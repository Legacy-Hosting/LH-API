import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { closeDatabase } from "../src/core/database/mysql.js";
import { createCsrfToken } from "../src/shared/security/csrf.js";

let app: FastifyInstance;

before(async () => {
  app = await buildApp();
});

after(async () => {
  await app.close();
  await closeDatabase();
});

test("public API metadata and security headers are available", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().version, "v1");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
});

test("the Ubuntu node installer is publicly downloadable", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/agent/install.sh",
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/x-shellscript/);
  assert.match(response.body, /Legacy Hosting node agent installed/);
});

test("cross-origin browser mutations are rejected before handlers", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login/options",
    headers: { origin: "https://attacker.invalid" },
    payload: {},
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, "invalid_request_origin");
});

test("panel preflights allow every API mutation method", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/admin/registration",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": method,
        "access-control-request-headers":
          "content-type,x-csrf-token,x-team-id",
      },
    });

    assert.equal(response.statusCode, 204);
    assert.match(response.headers["access-control-allow-methods"] ?? "", new RegExp(method));
  }
});

test("session-bearing mutations require the matching CSRF token", async () => {
  const missing = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: {
      origin: "http://localhost:5173",
      cookie: "lh_session=test-session",
    },
  });
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().error, "invalid_csrf_token");

  const acceptedByCsrfLayer = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: {
      origin: "http://localhost:5173",
      cookie: "lh_session=test-session",
      "x-csrf-token": createCsrfToken("test-session"),
    },
  });
  assert.notEqual(acceptedByCsrfLayer.statusCode, 403);
});

test("authentication endpoints enforce their stricter rate limit", async () => {
  const rateLimitedApp = await buildApp();
  try {
    let response;
    for (let index = 0; index < 11; index += 1) {
      response = await rateLimitedApp.inject({
        method: "POST",
        url: "/api/v1/auth/login/options",
        headers: { origin: "https://attacker.invalid" },
        payload: {},
      });
    }
    assert.equal(response?.statusCode, 429);
    assert.equal(response?.json().error, "rate_limit_exceeded");
  } finally {
    await rateLimitedApp.close();
  }
});

test("oversized request bodies are rejected", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login/options",
    headers: {
      origin: "http://localhost:5173",
      "content-type": "application/json",
    },
    payload: JSON.stringify({ value: "x".repeat(1_100_000) }),
  });
  assert.equal(response.statusCode, 413);
});
