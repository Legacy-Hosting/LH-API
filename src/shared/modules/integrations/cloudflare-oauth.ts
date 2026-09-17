import { env } from "../../../core/config/env.js";

const endpoints = {
  authorization: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
  userInfo: "https://dash.cloudflare.com/oauth2/userinfo",
} as const;

export type CloudflareTokenAuthMethod =
  | "client_secret_basic"
  | "client_secret_post";

export function buildCloudflareTokenRequest(
  tokenAuthMethod: CloudflareTokenAuthMethod,
  clientId: string,
  clientSecret: string,
  parameters: Record<string, string>,
) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Legacy-Hosting-Panel/1.0 (+https://legacyhosting.xyz)",
  };
  const body = new URLSearchParams(parameters);

  if (tokenAuthMethod === "client_secret_basic") {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }

  return { headers, body };
}

function configuration() {
  const values = {
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    redirectUri: env.CLOUDFLARE_OAUTH_REDIRECT_URI,
    tokenAuthMethod: env.CLOUDFLARE_OAUTH_TOKEN_AUTH_METHOD,
    scopes: env.CLOUDFLARE_OAUTH_SCOPES,
  };

  if (
    !values.clientId ||
    !values.clientSecret ||
    !values.redirectUri ||
    !values.scopes
  ) {
    throw new Error("Cloudflare OAuth is not configured");
  }
  return values as Record<keyof typeof values, string>;
}

async function cloudflareTokenError(
  response: Response,
  operation: "exchange" | "refresh",
) {
  const ray = response.headers.get("cf-ray");
  if (response.headers.get("cf-mitigated") === "challenge") {
    return new Error(
      `Cloudflare token ${operation} was blocked by an upstream challenge${ray ? ` (Ray ID: ${ray})` : ""}`,
    );
  }

  let providerError: string | undefined;
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") {
      providerError = payload.error.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80);
    }
  } catch {
    // The status code still gives a safe error when Cloudflare returns non-JSON.
  }

  return new Error(
    `Cloudflare token ${operation} failed with status ${response.status}${providerError ? ` (${providerError})` : ""}`,
  );
}

export function cloudflareAuthorizationUrl(state: string) {
  const config = configuration();
  const url = new URL(endpoints.authorization);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCloudflareCode(code: string) {
  const config = configuration();
  const request = buildCloudflareTokenRequest(
    config.tokenAuthMethod as CloudflareTokenAuthMethod,
    config.clientId,
    config.clientSecret,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    },
  );
  const response = await fetch(endpoints.token, {
    method: "POST",
    ...request,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw await cloudflareTokenError(response, "exchange");
  return response.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type: string;
    scope?: string;
  }>;
}

export async function refreshCloudflareAccessToken(refreshToken: string) {
  const config = configuration();
  const request = buildCloudflareTokenRequest(
    config.tokenAuthMethod as CloudflareTokenAuthMethod,
    config.clientId,
    config.clientSecret,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
  );
  const response = await fetch(endpoints.token, {
    method: "POST",
    ...request,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw await cloudflareTokenError(response, "refresh");
  return response.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type: string;
    scope?: string;
  }>;
}

export async function cloudflareUserInfo(accessToken: string) {
  const response = await fetch(endpoints.userInfo, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Cloudflare user info failed with status ${response.status}`,
    );
  return response.json() as Promise<{
    sub?: string;
    id?: string;
    email?: string;
    name?: string;
  }>;
}

export async function cloudflareZones(accessToken: string) {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/zones?per_page=50",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Cloudflare zone listing failed with status ${response.status}`,
    );
  const payload = (await response.json()) as {
    success: boolean;
    errors?: { code: number; message: string }[];
    result?: {
      id: string;
      name: string;
      status?: string;
      account?: { id: string; name: string };
    }[];
  };
  if (!payload.success)
    throw new Error(
      payload.errors?.[0]?.message ?? "Cloudflare zone listing failed",
    );
  return payload.result ?? [];
}

export const cloudflareOAuthEndpoints = endpoints;
