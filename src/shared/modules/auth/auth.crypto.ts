import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest();
}

export function safeTokenEqual(
  left: string | undefined,
  right: string | undefined,
) {
  if (!left || !right) return false;
  const leftHash = tokenHash(left);
  const rightHash = tokenHash(right);
  return timingSafeEqual(leftHash, rightHash);
}

export function uuidToBytes(uuid: string) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}
