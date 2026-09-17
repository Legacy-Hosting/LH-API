import { createSign } from "node:crypto";
import { env } from "../../../core/config/env.js";

type GitHubInstallation = {
  id: number;
  account: { id: number; login: string; type: string; avatar_url?: string };
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  suspended_at: string | null;
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  owner: { login: string };
};

function configuration() {
  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_SLUG ||
    !env.GITHUB_CLIENT_ID ||
    !env.GITHUB_CLIENT_SECRET ||
    !env.GITHUB_APP_PRIVATE_KEY_BASE64
  ) {
    throw new Error("GitHub App is not configured");
  }
  return {
    appId: env.GITHUB_APP_ID,
    slug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    privateKey: Buffer.from(
      env.GITHUB_APP_PRIVATE_KEY_BASE64,
      "base64",
    ).toString("utf8"),
  };
}

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function githubAppJwt() {
  const config = configuration();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 9 * 60, iss: config.appId })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(config.privateKey).toString("base64url")}`;
}

async function githubRequest<T>(
  path: string,
  token: string,
  init: RequestInit = {},
) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": env.GITHUB_API_VERSION,
      "User-Agent": "Legacy-Hosting-Panel",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API ${response.status}: ${error.slice(0, 300)}`);
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export function githubInstallationUrl(state: string) {
  const { slug } = configuration();
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function getGitHubInstallation(installationId: number) {
  return githubRequest<GitHubInstallation>(
    `/app/installations/${installationId}`,
    githubAppJwt(),
  );
}

export async function createGitHubInstallationToken(
  installationId: number,
  repositoryIds?: number[],
) {
  return githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    githubAppJwt(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        repositoryIds?.length ? { repository_ids: repositoryIds } : {},
      ),
    },
  );
}

export async function listGitHubInstallationRepositories(
  installationId: number,
) {
  const access = await createGitHubInstallationToken(installationId);
  const repositories: GitHubRepository[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await githubRequest<{
      total_count: number;
      repositories: GitHubRepository[];
    }>(`/installation/repositories?per_page=100&page=${page}`, access.token);
    repositories.push(...response.repositories);
    if (
      repositories.length >= response.total_count ||
      response.repositories.length < 100
    )
      break;
  }
  return repositories;
}

export async function githubInstallationRequest<T>(
  installationId: number,
  path: string,
  repositoryIds?: number[],
) {
  const access = await createGitHubInstallationToken(
    installationId,
    repositoryIds,
  );
  return githubRequest<T>(path, access.token);
}

export async function verifyGitHubInstallationForUser(
  installationId: number,
  authorizationCode: string,
) {
  const config = configuration();
  const tokenResponse = await fetch(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Legacy-Hosting-Panel",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: authorizationCode,
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const token = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(
      token.error_description || token.error || "GitHub authorization failed",
    );
  }
  await githubRequest(
    `/user/installations/${installationId}/repositories?per_page=1`,
    token.access_token,
  );
}
