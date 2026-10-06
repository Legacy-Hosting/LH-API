import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { updateApplication } from "../src/products/panel/modules/applications/application.service.js";
import { updateApplicationSchema } from "../src/products/panel/modules/applications/application.schema.js";

// Deliberately separate from DATABASE_URL: this test must never inherit a real
// workspace's database. Use a disposable MySQL container and a test-only schema.
const testUrl = process.env.LH_PANEL_HOSTNAME_TEST_DATABASE_URL;
test("separate process hostnames persist, route correctly and retry safely on real MySQL", { skip: !testUrl }, async (t) => {
  const url = new URL(testUrl!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Only a local disposable database is allowed");
  assert.match(url.pathname, /^\/lh_panel_hostname_test(?:_[a-z0-9]+)?$/);
  const pool = mysql.createPool({ uri: testUrl!, connectionLimit: 3, multipleStatements: true });
  const teamId = randomUUID();
  const userId = randomUUID();
  const nodeId = randomUUID();
  const applicationId = randomUUID();
  const domainId = randomUUID();
  const processId = randomUUID();
  const integrationId = randomUUID();
  const secret = Buffer.from("opaque-encrypted-secret-must-survive");
  const user = { id: userId, email: "hostname-test@example.invalid", displayName: "Hostname Test", isPlatformAdmin: false };
  let dnsFails = false;
  const dnsCalls: Array<{ hostname: string; rootDomain: string }> = [];
  const dependencies = {
    database: () => pool,
    provisionCloudflareCname: async (input: { hostname: string; rootDomain: string }) => {
      dnsCalls.push(input);
      if (dnsFails) throw new Error("simulated_dns_failure");
      return { integrationId, recordId: `record-${dnsCalls.length}` };
    },
  };
  const settings = (hostname = "api.apps.example.com") => updateApplicationSchema.parse({
    name: "hostname-test", branch: "main", autoDeploy: true, buildCommand: null, checkCommands: [], persistentPaths: [],
    processes: [
      { id: processId, name: "web", type: "web", executable: "node", args: ["server.js"], primary: true, public: true, routes: ["/"] },
      { name: "api", type: "api", executable: "node", args: ["api.js"], primary: false, public: true, routes: ["/"], hostname },
    ],
  });
  try {
    const [tables] = await pool.query<RowDataPacket[]>("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() LIMIT 1");
    if (!tables.length) {
      const directory = new URL("../database/migrations/", import.meta.url);
      for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort()) {
        await pool.query(await readFile(new URL(file, directory), "utf8"));
      }
    }
    await pool.execute("INSERT INTO users (id,email,display_name,status) VALUES (UUID_TO_BIN(?),?,'Hostname Test','active')", [userId, user.email]);
    await pool.execute("INSERT INTO teams (id,name,slug) VALUES (UUID_TO_BIN(?),'Hostname Test',?)", [teamId, `hostname-test-${teamId.slice(0, 8)}`]);
    await pool.execute(`INSERT INTO nodes (id,team_id,name,public_fqdn,public_ip,cname_target,status)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'test-node','test.example.net','198.18.0.10','test.example.net','online')`, [nodeId, teamId]);
    await pool.execute(`INSERT INTO integrations (id,team_id,provider,external_account_id,display_name,encrypted_credentials)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'cloudflare','test-account','Test Cloudflare',?)`, [integrationId, teamId, Buffer.alloc(40)]);
    for (const name of ["example.com", "apps.example.com"]) {
      await pool.execute(`INSERT INTO integration_resources (id,integration_id,resource_type,external_resource_id,display_name,enabled)
        VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'zone',?,?,TRUE)`, [randomUUID(), integrationId, name, name]);
    }
    await pool.execute(`INSERT INTO domains (id,team_id,hostname,root_domain,dns_target,status)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'portal.example.com','example.com','test.example.net','active')`, [domainId, teamId]);
    await pool.execute(`INSERT INTO applications (id,team_id,node_id,domain_id,name,storage_path,pm2_process_name,internal_port,status)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'hostname-test','/home/test','test-web',3000,'running')`, [applicationId, teamId, nodeId, domainId]);
    await pool.execute(`INSERT INTO application_domains (application_id,domain_id,is_primary,routing_mode)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),TRUE,'shared')`, [applicationId, domainId]);
    await pool.execute(`INSERT INTO application_processes (id,application_id,node_id,domain_id,name,pm2_process_name,process_type,executable,arguments,internal_port,is_primary,is_public,routes)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),UUID_TO_BIN(?),'web','test-web','web','node',JSON_ARRAY('server.js'),3000,TRUE,TRUE,JSON_ARRAY('/'))`, [processId, applicationId, nodeId, domainId]);
    await pool.execute(`INSERT INTO application_environment_variables (id,application_id,environment,process_name,variable_key,encrypted_value)
      VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'production','web','STORED_SECRET',?)`, [randomUUID(), applicationId, secret]);

    await t.test("save creates a dedicated hostname and its own proxy routes", async () => {
      const result = await updateApplication(applicationId, teamId, user, settings(), dependencies);
      assert.equal(result.domains[0]?.status, "configuring");
      const [rows] = await pool.query<RowDataPacket[]>(`SELECT p.name,p.internal_port AS port,d.hostname,ad.routing_mode AS mode
        FROM application_processes p JOIN domains d ON d.id=p.domain_id JOIN application_domains ad ON ad.application_id=p.application_id AND ad.domain_id=d.id
        WHERE p.application_id=UUID_TO_BIN(?) ORDER BY p.is_primary DESC`, [applicationId]);
      assert.deepEqual(rows.map((row) => ({ ...row })), [{ name: "web", port: 3000, hostname: "portal.example.com", mode: "shared" }, { name: "api", port: 3001, hostname: "api.apps.example.com", mode: "dedicated" }]);
      const [commands] = await pool.query<RowDataPacket[]>("SELECT payload FROM node_commands WHERE application_id=UUID_TO_BIN(?) AND command_type='configure_proxy'", [applicationId]);
      assert.equal(commands.length, 1);
      const payload = typeof commands[0]!.payload === "string" ? JSON.parse(commands[0]!.payload) : commands[0]!.payload;
      assert.deepEqual(payload.routes, [{ prefix: "/", port: 3001, processName: "api" }]);
      assert.equal(dnsCalls[0]!.rootDomain, "apps.example.com");
    });
    await t.test("saving again preserves IDs, ports and opaque environment secrets without another DNS request", async () => {
      const [before] = await pool.query<RowDataPacket[]>("SELECT HEX(id) AS id,internal_port AS port FROM application_processes WHERE application_id=UUID_TO_BIN(?) ORDER BY name", [applicationId]);
      await updateApplication(applicationId, teamId, user, settings(), dependencies);
      const [after] = await pool.query<RowDataPacket[]>("SELECT HEX(id) AS id,internal_port AS port FROM application_processes WHERE application_id=UUID_TO_BIN(?) ORDER BY name", [applicationId]);
      assert.deepEqual(after, before);
      assert.equal(dnsCalls.length, 1);
      const [variables] = await pool.query<RowDataPacket[]>("SELECT encrypted_value AS value FROM application_environment_variables WHERE application_id=UUID_TO_BIN(?)", [applicationId]);
      assert.deepEqual(variables[0]!.value, secret);
    });
    await t.test("failed DNS leaves saved settings retryable", async () => {
      dnsFails = true;
      const failed = await updateApplication(applicationId, teamId, user, settings("retry.apps.example.com"), dependencies);
      assert.equal(failed.domains[0]?.status, "error");
      dnsFails = false;
      const retry = await updateApplication(applicationId, teamId, user, settings("retry.apps.example.com"), dependencies);
      assert.equal(retry.domains[0]?.status, "configuring");
      const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS total FROM domains WHERE hostname='retry.apps.example.com'");
      assert.equal(Number(rows[0]!.total), 1);
    });
    await t.test("unconnected hostnames roll back without changing the saved process", async () => {
      await assert.rejects(updateApplication(applicationId, teamId, user, settings("api.unconnected.net"), dependencies), /cloudflare_zone_not_connected/);
      const [rows] = await pool.query<RowDataPacket[]>("SELECT d.hostname FROM application_processes p JOIN domains d ON d.id=p.domain_id WHERE p.application_id=UUID_TO_BIN(?) AND p.name='api'", [applicationId]);
      assert.equal(rows[0]!.hostname, "retry.apps.example.com");
    });
  } finally {
    // Fixtures only, in the explicitly local test schema validated above.
    await pool.execute("DELETE FROM audit_events WHERE team_id=UUID_TO_BIN(?)", [teamId]);
    await pool.execute("DELETE FROM applications WHERE team_id=UUID_TO_BIN(?)", [teamId]);
    await pool.execute("DELETE FROM domains WHERE team_id=UUID_TO_BIN(?)", [teamId]);
    await pool.execute("DELETE FROM integrations WHERE team_id=UUID_TO_BIN(?)", [teamId]);
    await pool.execute("DELETE FROM nodes WHERE team_id=UUID_TO_BIN(?)", [teamId]);
    await pool.execute("DELETE FROM teams WHERE id=UUID_TO_BIN(?)", [teamId]);
    await pool.execute("DELETE FROM users WHERE id=UUID_TO_BIN(?)", [userId]);
    await pool.end();
  }
});
