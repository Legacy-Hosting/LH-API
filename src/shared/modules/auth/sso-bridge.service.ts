import { z } from "zod";
import { env } from "../../../core/config/env.js";

const responseSchema = z.object({
  data: z.object({
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresIn: z.number().int().positive().max(120),
    completionUri: z.string().url(),
  }),
});

export class SsoBridgeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 503,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type BridgeOptions = {
  internalUrl?: string;
  issuer?: string;
  token?: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
};

export async function createSsoLoginTicket(
  input: {
    interactionUid: string;
    subject: string;
    email: string;
    displayName: string;
  },
  options: BridgeOptions = {},
) {
  const internalUrl = options.internalUrl ?? env.SSO_INTERNAL_URL;
  const issuer = options.issuer ?? env.SSO_ISSUER;
  const token = options.token ?? env.SSO_IDENTITY_BRIDGE_TOKEN;
  if (!internalUrl || !issuer || !token) throw new SsoBridgeError("sso_not_configured");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? env.SSO_REQUEST_TIMEOUT_MS,
  );
  timeout.unref();
  let response: Response;
  let responseBodyText = "";
  try {
    response = await (options.fetchImplementation ?? fetch)(
      new URL("/internal/oidc/login-tickets", internalUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      },
    );
    if (response.ok) responseBodyText = await response.text();
  } catch (error) {
    throw new SsoBridgeError("sso_unavailable", 503, { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 409) throw new SsoBridgeError("sso_identity_conflict", 409);
  if (!response.ok) throw new SsoBridgeError("sso_ticket_failed");
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseBodyText);
  } catch {
    responseBody = undefined;
  }
  const parsed = responseSchema.safeParse(responseBody);
  if (!parsed.success) throw new SsoBridgeError("invalid_sso_response");

  const completion = new URL(parsed.data.data.completionUri);
  const expectedIssuer = new URL(issuer);
  if (
    completion.origin !== expectedIssuer.origin ||
    completion.pathname !== `/interaction/${input.interactionUid}/complete` ||
    completion.search ||
    completion.hash
  ) {
    throw new SsoBridgeError("invalid_sso_response");
  }
  return parsed.data.data;
}
