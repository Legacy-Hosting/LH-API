import { env } from "../../../core/config/env.js";

const endpoints = {
  authorization: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
  userInfo: "https://dash.cloudflare.com/oauth2/userinfo",
} as const;

function configuration() {
  const values = {
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    clientSecret: env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    redirectUri: env.CLOUDFLARE_OAUTH_REDIRECT_URI,
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
  const response = await fetch(endpoints.token, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!response.ok)
    throw new Error(
      `Cloudflare token exchange failed with status ${response.status}`,
    );
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
  const response = await fetch(endpoints.token, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Cloudflare token refresh failed with status ${response.status}`,
    );
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
