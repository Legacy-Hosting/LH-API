import mysql, { type Pool } from "mysql2/promise";
import { env } from "../config/env.js";
import { databaseConnectionOptions } from "./connection-options.js";

let pool: Pool | undefined;
let statusCheck: Promise<"connected" | "unavailable"> | undefined;

function createPool() {
  return mysql.createPool({
    ...databaseConnectionOptions(),
    connectionLimit: 10,
    maxIdle: 4,
    idleTimeout: 60_000,
    queueLimit: 100,
    connectTimeout: env.DATABASE_CONNECT_TIMEOUT_MS,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
}

function discardPool(candidate: Pool) {
  if (pool !== candidate) return;
  pool = undefined;
  void candidate.end().catch(() => undefined);
}

async function probe(candidate: Pool) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      candidate.query("SELECT 1"),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Database health check timed out")),
          env.DATABASE_HEALTH_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function database(): Pool {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  pool ??= createPool();
  return pool;
}

export async function databaseStatus() {
  if (!env.DATABASE_URL) return "not_configured" as const;
  statusCheck ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidate = database();
      try {
        await probe(candidate);
        return "connected" as const;
      } catch {
        discardPool(candidate);
      }
    }
    return "unavailable" as const;
  })().finally(() => {
    statusCheck = undefined;
  });
  return statusCheck;
}

export function startDatabaseWatchdog(
  onStatusChange?: (status: "connected" | "unavailable") => void,
) {
  if (!env.DATABASE_URL) return () => undefined;
  let previousStatus: "connected" | "unavailable" | undefined;
  let running = false;
  const check = async () => {
    if (running) return;
    running = true;
    try {
      const status = await databaseStatus();
      if (status === "not_configured") return;
      if (status !== previousStatus) onStatusChange?.(status);
      previousStatus = status;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(check, env.DATABASE_HEALTH_INTERVAL_MS);
  timer.unref();
  void check();
  return () => clearInterval(timer);
}

export async function closeDatabase() {
  const candidate = pool;
  pool = undefined;
  if (candidate) await candidate.end();
}
