import assert from "node:assert/strict";
import { test } from "node:test";
import { createApplicationSchema } from "../src/products/panel/modules/applications/application.schema.js";
import { allocateApplicationPorts } from "../src/products/panel/modules/applications/application.service.js";

const base = {
  name: "bifrost",
  domain: "tg.legacyh.dev",
  rootDomain: "legacyh.dev",
  nodeId: "11111111-1111-4111-8111-111111111111",
  repository: "NextarchStudio/Bifrost",
  branch: "main",
};

const web = {
  name: "web",
  type: "web" as const,
  workingDirectory: "V2/Bifrost-Web",
  executable: "node" as const,
  args: ["server.mjs"],
  primary: true,
  public: true,
  routes: ["/"],
  enabled: true,
  startOrder: 0,
  instances: 1,
  restartDelayMs: 1000,
  inheritEnvironment: false,
  environment: {},
};

test("multi-process applications accept path routing, workers, aliases, and scoped variables", () => {
  const parsed = createApplicationSchema.safeParse({
    ...base,
    additionalHostnames: ["bifrost.tg.no"],
    processes: [
      web,
      {
        ...web,
        name: "api",
        type: "api",
        workingDirectory: "V2/Bifrost-API",
        args: ["--env-file-if-exists=.env", "dist/server.js"],
        primary: false,
        routes: ["/api/*", "/health", "/ready"],
        inheritEnvironment: true,
        portVariable: "BIFROST_API_PORT",
        environment: { DATABASE_HOST: "db.internal" },
      },
      {
        ...web,
        name: "worker",
        type: "worker",
        workingDirectory: "V2/Bifrost-Worker",
        args: ["dist/worker.js"],
        primary: false,
        public: false,
        routes: [],
        inheritEnvironment: true,
      },
    ],
    persistentPaths: [
      { path: "V2/var/secrets/settings.key", type: "file" },
      { path: "V2/var/uploads", type: "directory" },
    ],
  });
  assert.equal(parsed.success, true);
});

test("customers cannot supply PORT or expose a worker through HTTP", () => {
  assert.equal(
    createApplicationSchema.safeParse({
      ...base,
      environment: { PORT: "3000" },
      processes: [web],
    }).success,
    false,
  );
  assert.equal(
    createApplicationSchema.safeParse({
      ...base,
      processes: [{ ...web, type: "worker" }],
    }).success,
    false,
  );
});

test("ports are assigned only to web and API processes without reusing occupied ports", () => {
  assert.deepEqual(
    allocateApplicationPorts(
      ["web", "worker", "api", "custom", "web"],
      [3000, 3001, 3004],
    ),
    [3002, null, 3003, null, 3005],
  );
});
