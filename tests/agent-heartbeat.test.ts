import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseTimestamp } from "../src/products/panel/modules/agent/agent.routes.js";

test("heartbeat timestamps are converted from ISO strings for MySQL", () => {
  const timestamp = databaseTimestamp("2026-09-17T14:59:04.690Z");

  assert.ok(timestamp instanceof Date);
  assert.equal(timestamp.toISOString(), "2026-09-17T14:59:04.690Z");
  assert.equal(databaseTimestamp(null), null);
});
