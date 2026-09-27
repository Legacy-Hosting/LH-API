import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { after, test } from "node:test";
import type { RowDataPacket } from "mysql2";
import { closeDatabase, database } from "../src/core/database/mysql.js";

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
        'github_user_connections','github_user_installations','github_user_repository_access')`,
    );
    assert.equal(tables.length, 11);
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
        'ix_application_metric_traffic')`,
    );
    assert.equal(indexes.length, 3);
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
