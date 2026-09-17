import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { env } from "../config/env.js";

const LOCK_NAME = "legacy-hosting-schema-migrations";

async function migrate() {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");

  const connection = await mysql.createConnection({
    uri: env.DATABASE_URL,
    multipleStatements: true,
  });

  try {
    const [[lock]] = await connection.query<
      (RowDataPacket & { acquired: number })[]
    >("SELECT GET_LOCK(?, 30) AS acquired", [LOCK_NAME]);
    if (!lock?.acquired)
      throw new Error("Could not acquire the database migration lock");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration VARCHAR(255) PRIMARY KEY,
        checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    const migrationsDirectory = resolve(
      process.cwd(),
      "database",
      "migrations",
    );
    const migrations = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    for (const migration of migrations) {
      const sql = await readFile(
        resolve(migrationsDirectory, migration),
        "utf8",
      );
      const checksum = createHash("sha256").update(sql).digest("hex");
      const [applied] = await connection.query<
        (RowDataPacket & { checksum: string })[]
      >("SELECT checksum FROM schema_migrations WHERE migration=? LIMIT 1", [
        migration,
      ]);

      if (applied[0]) {
        if (applied[0].checksum !== checksum) {
          throw new Error(`Applied migration ${migration} has changed on disk`);
        }
        console.log(`Already applied: ${migration}`);
        continue;
      }

      console.log(`Applying: ${migration}`);
      await connection.query(sql);
      await connection.execute(
        "INSERT INTO schema_migrations (migration,checksum) VALUES (?,?)",
        [migration, checksum],
      );
    }
  } finally {
    try {
      await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    } finally {
      await connection.end();
    }
  }
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
