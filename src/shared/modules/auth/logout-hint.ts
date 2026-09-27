import { createHmac, randomBytes } from "node:crypto";

export function createLogoutHint(input: {
  audience: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  now?: () => number;
}) {
  const issuedAt = Math.floor((input.now ?? Date.now)() / 1_000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    aud: input.audience,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    iat: issuedAt,
    exp: issuedAt + 60,
    nonce: randomBytes(16).toString("base64url"),
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", input.clientSecret)
    .update(payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}
