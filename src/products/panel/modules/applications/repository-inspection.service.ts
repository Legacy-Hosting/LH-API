import type { RowDataPacket } from "mysql2";
import { database } from "../../../../core/database/mysql.js";
import { githubInstallationRequest } from "../../../../shared/modules/integrations/github-app.js";

type RepositoryRow = RowDataPacket & {
  installationId: string;
  repositoryId: string;
};
type ContentItem = {
  name: string;
  path: string;
  type: "file" | "dir";
  content?: string;
  encoding?: string;
};
type PackageManifest = {
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function executable(packageManager: string, script: string) {
  if (packageManager === "npm")
    return { command: "npm", args: ["run", script] };
  return { command: packageManager, args: [script] };
}

export async function inspectRepository(
  teamId: string,
  fullName: string,
  branch: string,
  requireStartCommand = true,
) {
  const [rows] = await database().query<RepositoryRow[]>(
    `SELECT i.external_account_id AS installationId,r.external_resource_id AS repositoryId
     FROM integration_resources r JOIN integrations i ON i.id=r.integration_id
     WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='github' AND i.disconnected_at IS NULL
       AND r.resource_type='repository' AND r.display_name=? AND r.enabled=TRUE LIMIT 1`,
    [teamId, fullName],
  );
  const repository = rows[0];
  if (!repository) throw new Error("repository_not_available");

  const [owner, name] = fullName.split("/");
  const root = await githubInstallationRequest<ContentItem[]>(
    Number(repository.installationId),
    `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/contents?ref=${encodeURIComponent(branch)}`,
    [Number(repository.repositoryId)],
  );
  const files = new Set(root.map((item) => item.name));
  if (!files.has("package.json"))
    throw new Error("unsupported_repository_runtime");

  const manifestFile = await githubInstallationRequest<ContentItem>(
    Number(repository.installationId),
    `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/contents/package.json?ref=${encodeURIComponent(branch)}`,
    [Number(repository.repositoryId)],
  );
  if (manifestFile.encoding !== "base64" || !manifestFile.content)
    throw new Error("invalid_package_manifest");
  const manifest = JSON.parse(
    Buffer.from(manifestFile.content.replace(/\n/g, ""), "base64").toString(
      "utf8",
    ),
  ) as PackageManifest;
  const dependencies = {
    ...manifest.devDependencies,
    ...manifest.dependencies,
  };
  const packageManager = files.has("pnpm-lock.yaml")
    ? "pnpm"
    : files.has("yarn.lock")
      ? "yarn"
      : files.has("bun.lockb") || files.has("bun.lock")
        ? "bun"
        : "npm";
  const install =
    packageManager === "npm"
      ? {
          command: "npm",
          args: [files.has("package-lock.json") ? "ci" : "install"],
        }
      : packageManager === "pnpm"
        ? { command: "pnpm", args: ["install", "--frozen-lockfile"] }
        : packageManager === "yarn"
          ? { command: "yarn", args: ["install", "--immutable"] }
          : { command: "bun", args: ["install", "--frozen-lockfile"] };
  const build = manifest.scripts?.build
    ? executable(packageManager, "build")
    : null;
  let start = manifest.scripts?.start
    ? executable(packageManager, "start")
    : null;
  if (!start && manifest.main)
    start = { command: "node", args: [manifest.main] };
  if (!start) {
    const entrypoint = ["server.js", "app.js", "index.js"].find((candidate) =>
      files.has(candidate),
    );
    if (entrypoint) start = { command: "node", args: [entrypoint] };
  }
  if (!start && requireStartCommand)
    throw new Error("start_command_not_detected");

  const framework = dependencies.next
    ? "nextjs"
    : dependencies.nuxt
      ? "nuxt"
      : dependencies["@nestjs/core"]
        ? "nestjs"
        : dependencies.fastify
          ? "fastify"
          : dependencies.express
            ? "express"
            : "node";

  return {
    kind: "node",
    framework,
    packageManager,
    install,
    build,
    start,
    detectedFrom: "package.json",
  };
}
