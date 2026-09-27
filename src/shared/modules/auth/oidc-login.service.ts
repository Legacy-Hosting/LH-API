import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import * as oidc from "openid-client";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";
import { decryptSecret, encryptSecret } from "../../security/secrets.js";
import { randomToken, tokenHash } from "./auth.crypto.js";

const loginRequestLifetimeSeconds = 600;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statePattern = /^[A-Za-z0-9_-]{43}$/;

type AuthorizationInput = {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  resource: string;
};

type ExchangeInput = {
  callbackUrl: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
  resource: string;
};

export type OidcProtocol = {
  authorizationUrl(input: AuthorizationInput): Promise<URL>;
  exchange(input: ExchangeInput): Promise<{ subject: string }>;
};

type OidcLoginOptions = {
  protocol?: OidcProtocol;
  issuer?: string;
  panelOrigin?: string;
  redirectUri?: string;
  resource?: string;
};

type LoginRequestRow = RowDataPacket & {
  encryptedCodeVerifier: Buffer;
  nonce: string;
  returnPath: string;
};

export class OidcLoginError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function requireConfiguration(value: string | undefined) {
  if (!value) throw new OidcLoginError("sso_not_configured", 503);
  return value;
}

function normalizedPanelPath(value: string | undefined, panelOrigin: string) {
  const fallback = "/";
  if (!value || value.length > 1_024 || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  try {
    const origin = new URL(panelOrigin);
    const destination = new URL(value, origin);
    if (destination.origin !== origin.origin) return fallback;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}

function boundedFetch(url: string, options: oidc.CustomFetchOptions) {
  const timeoutSignal = AbortSignal.timeout(env.SSO_REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...options, signal } as unknown as RequestInit);
}

let configurationPromise: Promise<oidc.Configuration> | undefined;

async function oidcConfiguration() {
  if (!configurationPromise) {
    const issuer = new URL(requireConfiguration(env.SSO_ISSUER));
    const clientId = requireConfiguration(env.SSO_CLIENT_ID);
    const clientSecret = requireConfiguration(env.SSO_CLIENT_SECRET);
    const execute = issuer.protocol === "http:" && env.NODE_ENV !== "production"
      ? [oidc.allowInsecureRequests]
      : undefined;
    configurationPromise = oidc.discovery(
      issuer,
      clientId,
      {
        client_secret: clientSecret,
        redirect_uris: [requireConfiguration(env.SSO_REDIRECT_URI)],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
      oidc.ClientSecretBasic(clientSecret),
      {
        [oidc.customFetch]: boundedFetch,
        ...(execute ? { execute } : {}),
      },
    ).then((configuration) => {
      configuration.timeout = Math.ceil(env.SSO_REQUEST_TIMEOUT_MS / 1_000);
      return configuration;
    }).catch((error) => {
      configurationPromise = undefined;
      throw error;
    });
  }
  return configurationPromise;
}

const defaultProtocol: OidcProtocol = {
  async authorizationUrl(input) {
    const configuration = await oidcConfiguration();
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: input.redirectUri,
      scope: "openid profile email",
      resource: input.resource,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      state: input.state,
      nonce: input.nonce,
    });
  },
  async exchange(input) {
    const configuration = await oidcConfiguration();
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      input.callbackUrl,
      {
        pkceCodeVerifier: input.codeVerifier,
        expectedState: input.state,
        expectedNonce: input.nonce,
        idTokenExpected: true,
      },
      { resource: input.resource },
    );
    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string") {
      throw new OidcLoginError("invalid_sso_identity");
    }
    return { subject: claims.sub };
  },
};

async function consumeLoginRequest(state: string) {
  if (!statePattern.test(state)) throw new OidcLoginError("invalid_sso_state");
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<LoginRequestRow[]>(
      `SELECT encrypted_code_verifier AS encryptedCodeVerifier,nonce,
              return_path AS returnPath
       FROM oidc_login_requests
       WHERE state_hash=? AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(3)
       LIMIT 1 FOR UPDATE`,
      [tokenHash(state)],
    );
    const loginRequest = rows[0];
    if (!loginRequest) {
      await connection.rollback();
      throw new OidcLoginError("invalid_or_expired_sso_state");
    }
    await connection.execute(
      "UPDATE oidc_login_requests SET consumed_at=UTC_TIMESTAMP(3) WHERE state_hash=?",
      [tokenHash(state)],
    );
    await connection.commit();
    return {
      codeVerifier: decryptSecret(loginRequest.encryptedCodeVerifier),
      nonce: loginRequest.nonce,
      returnPath: loginRequest.returnPath,
    };
  } catch (error) {
    if (!(error instanceof OidcLoginError)) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function beginOidcLogin(
  returnTo: string | undefined,
  options: OidcLoginOptions = {},
) {
  const issuer = requireConfiguration(options.issuer ?? env.SSO_ISSUER);
  const panelOrigin = options.panelOrigin ?? env.PANEL_ORIGIN;
  const redirectUri = requireConfiguration(options.redirectUri ?? env.SSO_REDIRECT_URI);
  const resource = requireConfiguration(options.resource ?? env.SSO_RESOURCE);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const codeVerifier = randomToken(32);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const returnPath = normalizedPanelPath(returnTo, panelOrigin);

  await database().execute(
    `DELETE FROM oidc_login_requests
     WHERE expires_at<=UTC_TIMESTAMP(3)
        OR consumed_at<UTC_TIMESTAMP(3)-INTERVAL 1 HOUR`,
  );
  await database().execute(
    `INSERT INTO oidc_login_requests
       (state_hash,encrypted_code_verifier,nonce,return_path,expires_at)
     VALUES (?,?,?,?,TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)))`,
    [
      tokenHash(state),
      encryptSecret(codeVerifier),
      nonce,
      returnPath,
      loginRequestLifetimeSeconds,
    ],
  );

  try {
    const authorizationUrl = await (options.protocol ?? defaultProtocol).authorizationUrl({
      state,
      nonce,
      codeChallenge,
      redirectUri,
      resource,
    });
    if (authorizationUrl.origin !== new URL(issuer).origin) {
      throw new OidcLoginError("invalid_sso_authorization_url", 503);
    }
    return { authorizationUrl: authorizationUrl.toString(), expiresIn: loginRequestLifetimeSeconds };
  } catch (error) {
    await database().execute("DELETE FROM oidc_login_requests WHERE state_hash=?", [tokenHash(state)]);
    if (error instanceof OidcLoginError) throw error;
    throw new OidcLoginError("sso_unavailable", 503, { cause: error });
  }
}

export async function completeOidcLogin(
  callbackUrl: URL,
  options: OidcLoginOptions = {},
) {
  const panelOrigin = options.panelOrigin ?? env.PANEL_ORIGIN;
  const resource = requireConfiguration(options.resource ?? env.SSO_RESOURCE);
  const state = callbackUrl.searchParams.get("state") ?? "";
  const loginRequest = await consumeLoginRequest(state);
  let identity: { subject: string };
  try {
    identity = await (options.protocol ?? defaultProtocol).exchange({
      callbackUrl,
      state,
      nonce: loginRequest.nonce,
      codeVerifier: loginRequest.codeVerifier,
      resource,
    });
  } catch (error) {
    if (error instanceof OidcLoginError) throw error;
    throw new OidcLoginError("sso_callback_failed", 401, { cause: error });
  }
  if (!uuidPattern.test(identity.subject)) {
    throw new OidcLoginError("invalid_sso_identity", 401);
  }
  const [users] = await database().query<(RowDataPacket & { id: string })[]>(
    `SELECT BIN_TO_UUID(id) AS id FROM users
     WHERE id=UUID_TO_BIN(?) AND status='active' LIMIT 1`,
    [identity.subject],
  );
  const user = users[0];
  if (!user) throw new OidcLoginError("sso_account_not_linked", 403);
  return {
    userId: user.id,
    returnUrl: new URL(loginRequest.returnPath, panelOrigin).toString(),
  };
}

export async function beginOidcLogout(options: OidcLoginOptions = {}) {
  const issuer = requireConfiguration(options.issuer ?? env.SSO_ISSUER);
  const clientId = requireConfiguration(env.SSO_CLIENT_ID);
  const panelOrigin = options.panelOrigin ?? env.PANEL_ORIGIN;
  try {
    const logoutUrl = oidc.buildEndSessionUrl(await oidcConfiguration(), {
      client_id: clientId,
      post_logout_redirect_uri: new URL("/", panelOrigin).toString(),
    });
    if (logoutUrl.origin !== new URL(issuer).origin) {
      throw new OidcLoginError("invalid_sso_logout_url", 503);
    }
    return logoutUrl.toString();
  } catch (error) {
    if (error instanceof OidcLoginError) throw error;
    throw new OidcLoginError("sso_unavailable", 503, { cause: error });
  }
}
