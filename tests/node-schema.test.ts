import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canManageNodes,
  createNodeBody,
  nodeSetup,
  updateNodeBody,
} from "../src/products/panel/modules/nodes/node.routes.js";

const baseNode = {
  name: "ams3-web-02",
  publicFqdn: "ams3.web-02.legacyh.fyi",
  cnameTarget: "ams3.web-02.legacyh.fyi",
  region: "Amsterdam, NL",
};

test("node registration accepts independent public and private dual-stack addresses", () => {
  const result = createNodeBody.safeParse({
    ...baseNode,
    publicIpv4: "203.0.113.20",
    publicIpv6: "2001:db8::20",
    privateFqdn: "ams3.web-02.internal.legacyh.fyi",
    privateIpv4: "10.0.0.20",
    privateIpv6: "fd00::20",
  });

  assert.equal(result.success, true);
});

test("node registration permits IPv6-only public connectivity", () => {
  const result = createNodeBody.safeParse({
    ...baseNode,
    publicIpv6: "2001:db8::20",
  });

  assert.equal(result.success, true);
});

test("node registration supports monitor-only control servers", () => {
  const result = createNodeBody.safeParse({
    ...baseNode,
    agentMode: "monitor-only",
    publicIpv4: "203.0.113.20",
  });

  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.agentMode, "monitor-only");
});

test("partial node updates do not silently change the agent mode", () => {
  const result = updateNodeBody.safeParse({ region: "ams3" });

  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.agentMode, undefined);
});

test("node registration rejects missing and mismatched public IP addresses", () => {
  assert.equal(createNodeBody.safeParse(baseNode).success, false);
  assert.equal(
    createNodeBody.safeParse({
      ...baseNode,
      publicIpv4: "2001:db8::20",
    }).success,
    false,
  );
  assert.equal(
    createNodeBody.safeParse({
      ...baseNode,
      publicIpv6: "203.0.113.20",
    }).success,
    false,
  );
});

test("node setup includes a copyable standalone installer command", () => {
  const nodeId = "11111111-1111-4111-8111-111111111111";
  const token = "abcdefghijklmnopqrstuvwxyzABCDEFGH12345678";
  const setup = nodeSetup(nodeId, token, "monitor-only");

  assert.match(setup.installCommand, /^curl -fsSL 'https:\/\//);
  assert.match(setup.installCommand, /agent\/install\.sh/);
  assert.ok(setup.installCommand.includes(`--node-id '${nodeId}'`));
  assert.ok(setup.installCommand.includes(`--token '${token}'`));
  assert.ok(setup.installCommand.includes("--mode 'monitor-only'"));
  assert.equal(setup.environment.LH_AGENT_MODE, "monitor-only");
  assert.equal(setup.environment.LH_COMMAND_POLL_INTERVAL_MS, "2000");
});

test("node administration is reserved for platform administrators", () => {
  assert.equal(canManageNodes({ isPlatformAdmin: true }), true);
  assert.equal(canManageNodes({ isPlatformAdmin: false }), false);
});
