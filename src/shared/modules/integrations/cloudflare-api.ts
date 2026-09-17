import type { RowDataPacket } from "mysql2";
import { database } from "../../../core/database/mysql.js";
import { decryptSecret, encryptSecret } from "../../security/secrets.js";
import { refreshCloudflareAccessToken } from "./cloudflare-oauth.js";

type TokenSet = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
};
type ZoneConnection = RowDataPacket & {
  integrationId: string;
  zoneId: string;
  credentials: Buffer;
  tokenExpiresAt: Date | null;
};

export async function cloudflareAccessForZone(
  teamId: string,
  rootDomain: string,
) {
  const [rows] = await database().query<ZoneConnection[]>(
    `SELECT BIN_TO_UUID(i.id) AS integrationId,r.external_resource_id AS zoneId,
            i.encrypted_credentials AS credentials,i.token_expires_at AS tokenExpiresAt
     FROM integration_resources r JOIN integrations i ON i.id=r.integration_id
     WHERE i.team_id=UUID_TO_BIN(?) AND i.provider='cloudflare' AND i.disconnected_at IS NULL
       AND r.resource_type='zone' AND r.display_name=? AND r.enabled=TRUE LIMIT 1`,
    [teamId, rootDomain],
  );
  const connection = rows[0];
  if (!connection) throw new Error("cloudflare_zone_not_connected");
  let tokens = JSON.parse(decryptSecret(connection.credentials)) as TokenSet;
  if (
    connection.tokenExpiresAt &&
    connection.tokenExpiresAt.getTime() < Date.now() + 60_000
  ) {
    if (!tokens.refresh_token) throw new Error("cloudflare_connection_expired");
    const refreshed = await refreshCloudflareAccessToken(tokens.refresh_token);
    tokens = {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    };
    const expiresAt = refreshed.expires_in
      ? new Date(Date.now() + refreshed.expires_in * 1000)
      : null;
    await database().execute(
      "UPDATE integrations SET encrypted_credentials=?,token_expires_at=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=UUID_TO_BIN(?)",
      [
        encryptSecret(JSON.stringify(tokens)),
        expiresAt,
        connection.integrationId,
      ],
    );
  }
  return {
    integrationId: connection.integrationId,
    zoneId: connection.zoneId,
    accessToken: tokens.access_token,
  };
}

async function cloudflareRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json()) as {
    success: boolean;
    result?: T;
    errors?: { code: number; message: string }[];
  };
  if (!response.ok || !payload.success)
    throw new Error(
      payload.errors?.[0]?.message ??
        `Cloudflare API failed with status ${response.status}`,
    );
  return payload.result as T;
}

export async function provisionCloudflareCname(input: {
  teamId: string;
  rootDomain: string;
  hostname: string;
  target: string;
  proxied: boolean;
}) {
  const connection = await cloudflareAccessForZone(
    input.teamId,
    input.rootDomain,
  );
  const existing = await cloudflareRequest<{ id: string }[]>(
    `/zones/${connection.zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(input.hostname)}`,
    connection.accessToken,
  );
  const body = JSON.stringify({
    type: "CNAME",
    name: input.hostname,
    content: input.target,
    proxied: input.proxied,
    ttl: 1,
  });
  const record = existing[0]
    ? await cloudflareRequest<{ id: string }>(
        `/zones/${connection.zoneId}/dns_records/${existing[0].id}`,
        connection.accessToken,
        { method: "PUT", body },
      )
    : await cloudflareRequest<{ id: string }>(
        `/zones/${connection.zoneId}/dns_records`,
        connection.accessToken,
        { method: "POST", body },
      );
  return { integrationId: connection.integrationId, recordId: record.id };
}

export async function removeCloudflareRecord(
  teamId: string,
  rootDomain: string,
  recordId: string,
) {
  const connection = await cloudflareAccessForZone(teamId, rootDomain);
  await cloudflareRequest(
    `/zones/${connection.zoneId}/dns_records/${recordId}`,
    connection.accessToken,
    { method: "DELETE" },
  );
}
