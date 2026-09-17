import assert from "node:assert/strict";
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
    assert.equal(Number(migrations[0]?.total), 13);

    const [tables] = await database().query<
      (RowDataPacket & { tableName: string })[]
    >(
      `SELECT table_name AS tableName FROM information_schema.tables
       WHERE table_schema=DATABASE() AND table_name IN
       ('users','applications','node_metrics','application_health_checks','agent_request_nonces')`,
    );
    assert.equal(tables.length, 5);
  },
);
