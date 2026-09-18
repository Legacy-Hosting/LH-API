import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeWithoutRootManifest } from "../src/products/panel/modules/applications/repository-inspection.service.js";

test("a nested monorepo can use an explicitly configured runtime", () => {
  const runtime = runtimeWithoutRootManifest({
    install: {
      command: "pnpm",
      args: ["--dir", "V2", "install", "--frozen-lockfile"],
    },
    build: {
      command: "pnpm",
      args: ["--dir", "V2", "-r", "build"],
    },
  });

  assert.equal(runtime.detectedFrom, "manual_configuration");
  assert.deepEqual(runtime.install.args, [
    "--dir",
    "V2",
    "install",
    "--frozen-lockfile",
  ]);
  assert.deepEqual(runtime.build?.args, ["--dir", "V2", "-r", "build"]);
  assert.equal(runtime.start, null);
});

test("automatic detection still rejects repositories without a root manifest", () => {
  assert.throws(
    () => runtimeWithoutRootManifest(),
    /unsupported_repository_runtime/,
  );
});
