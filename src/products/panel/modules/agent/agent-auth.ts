import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import { env } from "../../../../core/config/env.js";
import { database } from "../../../../core/database/mysql.js";

type CredentialRow = RowDataPacket & { authentication_key: Buffer };

export async function authenticateAgentRequest(request: FastifyRequest) {
  const nodeId = request.headers["x-lh-node-id"];
  const timestamp = request.headers["x-lh-timestamp"];
  const signature = request.headers["x-lh-signature"];
  const nonce = request.headers["x-lh-nonce"];
  const signatureV2 = request.headers["x-lh-signature-v2"];
  if (
    typeof nodeId !== "string" ||
    typeof timestamp !== "string" ||
    typeof signature !== "string"
  )
    return null;
  if (
    !z.string().uuid().safeParse(nodeId).success ||
    !/^\d{13}$/.test(timestamp) ||
    !/^[a-f0-9]{64}$/i.test(signature)
  )
    return null;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return null;

  const [rows] = await database().query<CredentialRow[]>(
    "SELECT authentication_key FROM node_agent_credentials WHERE node_id=UUID_TO_BIN(?) AND revoked_at IS NULL LIMIT 1",
    [nodeId],
  );
  const credential = rows[0];
  if (!credential) return null;
  const body = JSON.stringify(request.body);
  const usesV2 =
    typeof nonce === "string" &&
    z.string().uuid().safeParse(nonce).success &&
    typeof signatureV2 === "string" &&
    /^[a-f0-9]{64}$/i.test(signatureV2);
  if (usesV2) {
    const expected = createHmac("sha256", credential.authentication_key)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest();
    const received = Buffer.from(signatureV2, "hex");
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      return null;
    const [inserted] = await database().execute<ResultSetHeader>(
      `INSERT IGNORE INTO agent_request_nonces (node_id,nonce)
       VALUES (UUID_TO_BIN(?),?)`,
      [nodeId, nonce],
    );
    return inserted.affectedRows === 1 ? nodeId : null;
  }
  if (!env.ALLOW_LEGACY_AGENT_SIGNATURES) return null;
  const expected = createHmac("sha256", credential.authentication_key)
    .update(`${timestamp}.${body}`)
    .digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected)
    ? nodeId
    : null;
}
