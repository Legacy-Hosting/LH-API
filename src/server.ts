import { buildApp } from "./app.js";
import { env } from "./core/config/env.js";
import {
  closeDatabase,
  startDatabaseWatchdog,
} from "./core/database/mysql.js";

const app = await buildApp();
const stopDatabaseWatchdog = startDatabaseWatchdog((status) => {
  if (status === "unavailable") {
    app.log.error("Database is unavailable; the connection pool was recycled");
  } else {
    app.log.info("Database connection is healthy");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopDatabaseWatchdog();
    await app.close();
    await closeDatabase();
    process.exit(0);
  });
}

await app.listen({ host: env.HOST, port: env.PORT });
