import mysql, { type Pool } from "mysql2/promise";
import { env } from "../config/env.js";

let pool: Pool | undefined;

export function database(): Pool {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  pool ??= mysql.createPool({
    uri: env.DATABASE_URL,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
  return pool;
}

export async function databaseStatus() {
  if (!env.DATABASE_URL) return "not_configured" as const;
  try {
    await database().query("SELECT 1");
    return "connected" as const;
  } catch {
    return "unavailable" as const;
  }
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}
