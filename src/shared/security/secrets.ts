import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../core/config/env.js";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey() {
  if (!env.CREDENTIAL_ENCRYPTION_KEY)
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, "base64");
  if (key.length !== 32)
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  return key;
}

export function encryptSecret(value: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([VERSION]),
    iv,
    cipher.getAuthTag(),
    encrypted,
  ]);
}

export function decryptSecret(payload: Buffer) {
  if (payload[0] !== VERSION || payload.length < 1 + IV_BYTES + TAG_BYTES)
    throw new Error("Unsupported encrypted secret format");
  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const encrypted = payload.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}
