import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { operationsRoutes } from "../src/shared/modules/operations/operations.routes.js";
import { assembleOperationsSummary } from "../src/shared/modules/operations/operations.service.js";

const summary = assembleOperationsSummary({
  generatedAt: new Date("2026-09-27T10:00:00.000Z"),
  applications: {
    total: 7,
    running: 5,
    failed: 1,
    deploying: 1,
    stopped: 0,
    pending: 0,
  } as never,
  agents: {
    total: "3",
    online: "2",
    offline: "1",
    pending: 0,
    draining: 0,
    lastHeartbeatAt: "2026-09-27T09:59:50.000Z",
  } as never,
  deployments: {
    total: 10,
    succeeded: 8,
    failed: 2,
    inProgress: 0,
    queued: 0,
    cancelled: 0,
  } as never,
  recentDeployments: [{
    id: "a8c17a56-7a25-4b11-a6ab-0c42316bde2f",
    applicationName: "panel",
    teamName: "Legacy Hosting",
    status: "succeeded",
    source: "github_push",
    commitSha: "a".repeat(40),
    createdAt: "2026-09-27T09:55:00.000Z",
    startedAt: "2026-09-27T09:55:01.000Z",
    finishedAt: "2026-09-27T09:56:00.000Z",
  }] as never,
});

test("operations summary normalizes counts and computes the 24 hour success rate", () => {
  assert.equal(summary.database.state, "connected");
  assert.equal(summary.agents.online, 2);
  assert.equal(summary.deployments.successRate, 80);
  assert.equal(summary.deployments.windowHours, 24);
  assert.equal(summary.deployments.recent[0]?.applicationName, "panel");
});

test("Hub operations endpoint permits operational roles without granting support access", async () => {
  const app = Fastify();
  await app.register(operationsRoutes, {
    tokenVerifier: async (token) => ({
      sub: "staff-1",
      roles: token === "infrastructure-token" ? ["infrastructure"] : ["support"],
    }),
    reader: async () => summary,
  });
  try {
    const missing = await app.inject({ method: "GET", url: "/operations" });
    assert.equal(missing.statusCode, 401);

    const denied = await app.inject({
      method: "GET",
      url: "/operations",
      headers: { authorization: "Bearer support-token" },
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await app.inject({
      method: "GET",
      url: "/operations",
      headers: { authorization: "Bearer infrastructure-token" },
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.json().data, summary);
    assert.equal(allowed.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
});
