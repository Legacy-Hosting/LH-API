import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { after, test } from "node:test";
import type { RowDataPacket } from "mysql2";
import { closeDatabase, database } from "../src/core/database/mysql.js";
import { readOperationsSummary } from "../src/shared/modules/operations/operations.service.js";
import {
  readGlobalFirewallPolicy,
  recordGlobalFirewallBans,
  removeGlobalFirewallBan,
} from "../src/products/panel/modules/firewall/firewall.service.js";

after(async () => {
  await closeDatabase();
});

test(
  "all migrations are applied to MySQL 8 and core tables exist",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [migrations] = await database().query<
      (RowDataPacket & { total: number })[]
    >("SELECT COUNT(*) AS total FROM schema_migrations");
    const migrationFiles = await readdir(
      new URL("../database/migrations/", import.meta.url),
    );
    const expectedMigrations = migrationFiles.filter((file) =>
      file.endsWith(".sql"),
    ).length;
    assert.equal(Number(migrations[0]?.total), expectedMigrations);

    const [tables] = await database().query<
      (RowDataPacket & { tableName: string })[]
    >(
      `SELECT table_name AS tableName FROM information_schema.tables
       WHERE table_schema=DATABASE() AND table_name IN
       ('users','applications','application_processes','application_domains',
        'application_persistent_paths','node_metrics','application_health_checks','agent_request_nonces',
        'github_user_connections','github_user_installations','github_user_repository_access',
        'global_firewall_bans')`,
    );
    assert.equal(tables.length, 12);
  },
);

test(
  "an administrative unban suppresses the still-active Fail2Ban report",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const userId = "26262626-2626-4626-8626-262626262626";
    const teamId = "27272727-2727-4727-8727-272727272727";
    const nodeId = "28282828-2828-4828-8828-282828282828";
    const ipAddress = "8.8.8.8";
    await database().execute(
      `INSERT INTO users (id,email,display_name,status)
       VALUES (UUID_TO_BIN(?),'firewall-test@example.invalid','Firewall Test','active')`,
      [userId],
    );
    await database().execute(
      "INSERT INTO teams (id,name,slug) VALUES (UUID_TO_BIN(?),'Firewall Test','firewall-test')",
      [teamId],
    );
    await database().execute(
      `INSERT INTO nodes
       (id,team_id,name,public_fqdn,public_ip,cname_target,status,agent_mode)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'firewall-test-node',
               'firewall-test.legacyh.fyi','198.18.0.10',
               'firewall-test.legacyh.fyi','online','monitor-only')`,
      [nodeId, teamId],
    );

    try {
      const first = await database().getConnection();
      try {
        await first.beginTransaction();
        await recordGlobalFirewallBans(first, nodeId, [
          { ipAddress, jail: "sshd" },
        ]);
        await first.commit();
      } finally {
        first.release();
      }
      assert.ok((await readGlobalFirewallPolicy()).activeIps.includes(ipAddress));

      assert.equal(
        await removeGlobalFirewallBan({
          ipAddress,
          reason: "False positive in integration test",
          userId,
          teamId,
        }),
        true,
      );

      const repeated = await database().getConnection();
      try {
        await repeated.beginTransaction();
        await recordGlobalFirewallBans(repeated, nodeId, [
          { ipAddress, jail: "sshd" },
        ]);
        await repeated.commit();
      } finally {
        repeated.release();
      }
      const policy = await readGlobalFirewallPolicy();
      assert.equal(policy.activeIps.includes(ipAddress), false);
      assert.equal(policy.unbanIps.includes(ipAddress), true);
    } finally {
      await database().execute(
        "DELETE FROM global_firewall_bans WHERE ip_address=?",
        [ipAddress],
      );
      await database().execute(
        "DELETE FROM audit_events WHERE resource_type='ip_address' AND resource_id=?",
        [ipAddress],
      );
      await database().execute("DELETE FROM nodes WHERE id=UUID_TO_BIN(?)", [nodeId]);
      await database().execute("DELETE FROM teams WHERE id=UUID_TO_BIN(?)", [teamId]);
      await database().execute("DELETE FROM users WHERE id=UUID_TO_BIN(?)", [userId]);
    }
  },
);

test(
  "application status lookups use their composite indexes",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [indexes] = await database().query<
      (RowDataPacket & { indexName: string })[]
    >(
      `SELECT DISTINCT index_name AS indexName
       FROM information_schema.statistics
       WHERE table_schema=DATABASE() AND index_name IN
       ('ix_pm2_snapshot_node_process_recorded',
        'ix_application_team_active_created',
        'ix_application_metric_traffic',
        'ix_deployment_created_status',
        'ix_application_active_status',
        'ix_node_status_heartbeat')`,
    );
    assert.equal(indexes.length, 6);
  },
);

test(
  "Hub operations summary runs against an empty strict MySQL schema",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const summary = await readOperationsSummary();
    assert.equal(summary.database.state, "connected");
    assert.equal(summary.applications.total, 0);
    assert.equal(summary.agents.total, 0);
    assert.equal(summary.deployments.total, 0);
    assert.equal(summary.deployments.successRate, null);
  },
);

test(
  "monitoring time buckets work with ONLY_FULL_GROUP_BY",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [rows] = await database().query<RowDataPacket[]>(
      `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(recorded_at)/?)*?) AS recordedAt,
              AVG(load_1) AS load1
       FROM node_metrics
       WHERE recorded_at>=UTC_TIMESTAMP()-INTERVAL 24 HOUR
       GROUP BY recordedAt
       ORDER BY recordedAt`,
      [300, 300],
    );

    assert.ok(Array.isArray(rows));
  },
);

test(
  "application process aliases are valid in strict MySQL modes",
  { skip: !process.env.DATABASE_URL },
  async () => {
    const [rows] = await database().query<RowDataPacket[]>(
      `SELECT is_primary AS \`primary\`,is_public AS \`public\`
       FROM application_processes LIMIT 1`,
    );

    assert.ok(Array.isArray(rows));
  },
);
