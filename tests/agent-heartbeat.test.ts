import assert from "node:assert/strict";
import { test } from "node:test";
import {
  databaseTimestamp,
  heartbeatSchema,
} from "../src/products/panel/modules/agent/agent.routes.js";

test("heartbeat timestamps are converted from ISO strings for MySQL", () => {
  const timestamp = databaseTimestamp("2026-09-17T14:59:04.690Z");

  assert.ok(timestamp instanceof Date);
  assert.equal(timestamp.toISOString(), "2026-09-17T14:59:04.690Z");
  assert.equal(databaseTimestamp(null), null);
});

const heartbeat = {
  agentVersion: "1.0.31",
  sentAt: "2026-09-17T14:59:04.690Z",
  system: {
    hostname: "ams3-api-01",
    uptimeSeconds: 10,
    loadAverage: [0, 0, 0],
    memoryTotalBytes: 1,
    memoryUsedBytes: 1,
    memoryUsedPercent: 1,
    diskUsedPercent: 1,
    networkReceivedBytes: 0,
    networkSentBytes: 0,
  },
  processes: [],
  applicationTraffic: [],
};

test("heartbeat accepts explicit monitor-only mode", () => {
  const result = heartbeatSchema.safeParse({ ...heartbeat, mode: "monitor-only" });
  assert.equal(result.success, true);
});

test("legacy hosting agents default to hosting-node mode during rollout", () => {
  const result = heartbeatSchema.safeParse(heartbeat);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.mode, "hosting-node");
});
