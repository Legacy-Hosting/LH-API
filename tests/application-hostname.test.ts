import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "mysql2/promise";
import { updateApplication } from "../src/products/panel/modules/applications/application.service.js";
import { updateApplicationSchema } from "../src/products/panel/modules/applications/application.schema.js";

const applicationId = "11111111-1111-4111-8111-111111111111";
const teamId = "22222222-2222-4222-8222-222222222222";
const primaryDomainId = "33333333-3333-4333-8333-333333333333";
const processId = "44444444-4444-4444-8444-444444444444";
const nodeId = "55555555-5555-4555-8555-555555555555";
const user = { id: "66666666-6666-4666-8666-666666666666", email: "test@example.invalid", displayName: "Test", isPlatformAdmin: false };
const web = { id: processId, name: "web", type: "web", executable: "node", args: ["server.js"], primary: true, public: true, routes: ["/"] };
const api = { name: "api", type: "api", executable: "node", args: ["api.js"], public: true, routes: ["/"], hostname: "api.apps.example.com" };

function settings(processes: unknown[] = [web, api]) {
  return updateApplicationSchema.parse({ name: "portal", branch: "main", autoDeploy: true, buildCommand: null, checkCommands: [], persistentPaths: [], processes });
}

function fixture(options: {
  zones?: string[];
  claimed?: boolean;
  dnsFails?: boolean;
  saveFails?: boolean;
  errorWriteFails?: boolean;
  domains?: Array<{ id: string; hostname: string; rootDomain: string; routingMode: string; status: string }>;
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const events: string[] = [];
  const dnsCalls: Array<Record<string, unknown>> = [];
  const domainRows = [{ id: primaryDomainId, hostname: "portal.example.com", rootDomain: "example.com", routingMode: "shared", status: "active" }, ...(options.domains ?? [])];
  const execute = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (options.saveFails && sql.includes("UPDATE applications")) throw new Error("save_failed");
    if (options.errorWriteFails && sql.includes("status='error'")) throw new Error("database_unavailable");
    return [{ affectedRows: 1 }, []];
  };
  const connection = {
    beginTransaction: async () => { events.push("begin"); },
    commit: async () => { events.push("commit"); },
    rollback: async () => { events.push("rollback"); },
    release: () => { events.push("release"); },
    execute,
    query: async (sql: string) => {
      if (sql.includes("a.detected_runtime AS runtime")) return [[{ runtime: {}, repository: null, nodeId, domainId: primaryDomainId, status: "running", teamSlug: "test", cnameTarget: "node.example.net" }], []];
      if (sql.includes("FROM application_processes WHERE")) return [[{ id: processId, name: "web", processName: "test-portal-web", internalPort: 3000 }], []];
      if (sql.includes("FROM application_domains")) return [domainRows, []];
      if (sql.includes("integration_resources")) return [(options.zones ?? ["apps.example.com", "example.com"]).map((name) => ({ name })), []];
      if (sql.includes("WHERE hostname=?")) return [options.claimed ? [{ id: "another-application-domain" }] : [], []];
      if (sql.includes("UNION") || sql.includes("FROM application_environment_variables")) return [[], []];
      throw new Error(`Unexpected fixture query: ${sql}`);
    },
  };
  const pool = { getConnection: async () => connection, execute } as unknown as Pool;
  const dependencies = {
    database: () => pool,
    provisionCloudflareCname: async (input: Record<string, unknown>) => {
      assert.equal(events.at(-1), "release", "settings must commit and release before contacting Cloudflare");
      assert.ok(events.includes("commit"));
      dnsCalls.push(input);
      events.push("dns");
      if (options.dnsFails) throw new Error("cloudflare_dns_failed");
      return { integrationId: teamId, recordId: "test-record" };
    },
  };
  return { calls, events, dnsCalls, dependencies };
}

test("editing creates a dedicated domain, provisions the most specific connected zone, and queues only its routes", async () => {
  const f = fixture();
  const result = await updateApplication(applicationId, teamId, user, settings(), f.dependencies);
  assert.deepEqual(result, { updated: true, domains: [{ hostname: api.hostname, status: "configuring" }] });
  assert.deepEqual(f.dnsCalls, [{ teamId, rootDomain: "apps.example.com", hostname: api.hostname, target: "node.example.net", proxied: true }]);
  const domainInsert = f.calls.find((call) => call.sql.includes("INSERT INTO domains"))!;
  assert.equal(domainInsert.values[1], teamId);
  const link = f.calls.find((call) => call.sql.includes("INSERT INTO application_domains"))!;
  assert.match(link.sql, /FALSE,'dedicated'/);
  const processInsert = f.calls.find((call) => call.sql.includes("INSERT INTO application_processes"))!;
  assert.equal(processInsert.values[3], domainInsert.values[0]);
  assert.equal(processInsert.values[10], 3001);
  const command = f.calls.find((call) => call.sql.includes("INSERT INTO node_commands"))!;
  assert.deepEqual(JSON.parse(command.values[1] as string), { domainId: domainInsert.values[0], hostname: api.hostname, rootDomain: "apps.example.com", routes: [{ prefix: "/", port: 3001, processName: "api" }] });
  assert.equal(f.events.filter((event) => event === "commit").length, 2);
  assert.equal(f.events.includes("rollback"), false);
});

test("several processes on one new hostname create only one DNS record and preserve independent ports", async () => {
  const f = fixture();
  await updateApplication(applicationId, teamId, user, settings([web, { ...api, routes: ["/api/*"] }, { ...api, name: "health", routes: ["/health"] }]), f.dependencies);
  assert.equal(f.dnsCalls.length, 1);
  assert.equal(f.calls.filter((call) => call.sql.includes("INSERT INTO domains")).length, 1);
  const command = f.calls.find((call) => call.sql.includes("INSERT INTO node_commands"))!;
  assert.deepEqual(JSON.parse(command.values[1] as string).routes, [{ prefix: "/api/*", port: 3001, processName: "api" }, { prefix: "/health", port: 3002, processName: "health" }]);
});

test("ordinary edits preserve the shared hostname without creating DNS or proxy commands", async () => {
  const f = fixture();
  const result = await updateApplication(applicationId, teamId, user, settings([web, { ...api, hostname: undefined, routes: ["/api/*"] }]), f.dependencies);
  assert.deepEqual(result, { updated: true, domains: [] });
  assert.equal(f.dnsCalls.length, 0);
  assert.equal(f.calls.some((call) => call.sql.includes("INSERT INTO domains")), false);
  assert.equal(f.calls.find((call) => call.sql.includes("INSERT INTO application_processes"))!.values[3], primaryDomainId);
});

test("a disabled public process reserves its hostname without queuing an empty proxy configuration", async () => {
  const f = fixture();
  const result = await updateApplication(applicationId, teamId, user, settings([web, { ...api, enabled: false }]), f.dependencies);
  assert.deepEqual(result, { updated: true, domains: [{ hostname: api.hostname, status: "pending" }] });
  assert.equal(f.dnsCalls.length, 0);
  assert.equal(f.calls.some((call) => call.sql.includes("INSERT INTO domains")), true);
  assert.equal(f.calls.some((call) => call.sql.includes("INSERT INTO node_commands")), false);
});

for (const [name, options, error] of [
  ["unconnected zones", { zones: ["elsewhere.net"] }, "cloudflare_zone_not_connected"],
  ["hostnames already owned by another application", { claimed: true }, "application_or_domain_exists"],
  ["shared application aliases", { domains: [{ id: teamId, hostname: api.hostname, rootDomain: "example.com", routingMode: "shared", status: "active" }] }, "process_hostname_is_shared_alias"],
] as const) {
  test(`editing rejects ${name} without external side effects`, async () => {
    const f = fixture({ ...options, ...("zones" in options ? { zones: [...options.zones] } : {}), ...("domains" in options ? { domains: [...options.domains] } : {}) });
    await assert.rejects(updateApplication(applicationId, teamId, user, settings(), f.dependencies), new RegExp(error));
    assert.equal(f.dnsCalls.length, 0);
    assert.equal(f.events.includes("commit"), false);
    assert.equal(f.events.includes("rollback"), true);
  });
}

test("a failed settings transaction never provisions DNS", async () => {
  const f = fixture({ saveFails: true });
  await assert.rejects(updateApplication(applicationId, teamId, user, settings(), f.dependencies), /save_failed/);
  assert.equal(f.dnsCalls.length, 0);
  assert.equal(f.events.includes("commit"), false);
});

test("DNS failure reports a partial setup without pretending the saved settings were rolled back", async () => {
  const f = fixture({ dnsFails: true });
  assert.deepEqual(await updateApplication(applicationId, teamId, user, settings(), f.dependencies), { updated: true, domains: [{ hostname: api.hostname, status: "error" }] });
  assert.equal(f.events.filter((event) => event === "commit").length, 1);
  assert.equal(f.events.includes("rollback"), false);
  assert.ok(f.calls.some((call) => call.sql.includes("status='error'")));
  assert.equal(f.calls.some((call) => call.sql.includes("INSERT INTO node_commands")), false);
});

test("a database outage after committed settings still returns a partial provisioning warning", async () => {
  const f = fixture({ dnsFails: true, errorWriteFails: true });
  assert.deepEqual(await updateApplication(applicationId, teamId, user, settings(), f.dependencies), { updated: true, domains: [{ hostname: api.hostname, status: "error" }] });
  assert.equal(f.events.filter((event) => event === "commit").length, 1);
  assert.equal(f.events.includes("rollback"), false);
});

for (const status of ["active", "pending", "error"]) {
  test(`an existing ${status} dedicated hostname is reused${status === "active" ? "" : " and provisioning retried"}`, async () => {
    const f = fixture({ domains: [{ id: teamId, hostname: api.hostname, rootDomain: "apps.example.com", routingMode: "dedicated", status }] });
    await updateApplication(applicationId, teamId, user, settings(), f.dependencies);
    assert.equal(f.calls.some((call) => call.sql.includes("INSERT INTO domains")), false);
    assert.equal(f.dnsCalls.length, status === "active" ? 0 : 1);
    assert.equal(f.calls.find((call) => call.sql.includes("INSERT INTO application_processes"))!.values[3], teamId);
  });
}
