import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
} from "@simplewebauthn/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";

type UserRow = RowDataPacket & { id: string };
type PasskeyRow = RowDataPacket & {
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports: string | AuthenticatorTransport[] | null;
};
type ChallengeRow = RowDataPacket & {
  id: string;
  user_id: string | null;
  challenge: string;
};

function transports(
  value: PasskeyRow["transports"],
): AuthenticatorTransport[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as AuthenticatorTransport[];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function beginAuthentication(email?: string) {
  let userId: string | null = null;
  let allowCredentials: {
    id: string;
    transports?: AuthenticatorTransport[];
  }[] = [];
  if (email) {
    const [users] = await database().query<UserRow[]>(
      "SELECT BIN_TO_UUID(id) AS id FROM users WHERE email=? AND status='active' LIMIT 1",
      [email.trim().toLowerCase()],
    );
    userId = users[0]?.id ?? null;
    if (!userId) throw new Error("account_not_found");
    const [passkeys] = await database().query<PasskeyRow[]>(
      "SELECT credential_id,transports FROM user_passkeys WHERE user_id=UUID_TO_BIN(?)",
      [userId],
    );
    allowCredentials = passkeys.map((passkey) => ({
      id: passkey.credential_id,
      transports: transports(passkey.transports),
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    userVerification: "required",
    allowCredentials,
  });
  const challengeId = randomUUID();
  await database().execute(
    `INSERT INTO auth_challenges (id,user_id,ceremony,challenge,expires_at)
     VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'authentication',?,CURRENT_TIMESTAMP(3)+INTERVAL 5 MINUTE)`,
    [challengeId, userId, options.challenge],
  );
  return { challengeId, options };
}

export async function finishAuthentication(input: {
  challengeId: string;
  response: AuthenticationResponseJSON;
}) {
  const [challengeRows] = await database().query<ChallengeRow[]>(
    `SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(user_id) AS user_id, challenge
     FROM auth_challenges WHERE id=UUID_TO_BIN(?) AND ceremony='authentication'
       AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
    [input.challengeId],
  );
  const challenge = challengeRows[0];
  if (!challenge) throw new Error("invalid_or_expired_challenge");

  const [passkeyRows] = await database().query<PasskeyRow[]>(
    `SELECT BIN_TO_UUID(user_id) AS user_id,credential_id,public_key,counter,transports
     FROM user_passkeys WHERE credential_id=? LIMIT 1`,
    [input.response.id],
  );
  const passkey = passkeyRows[0];
  if (!passkey || (challenge.user_id && challenge.user_id !== passkey.user_id))
    throw new Error("unknown_passkey");

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
    requireUserVerification: true,
    credential: {
      id: passkey.credential_id,
      publicKey: new Uint8Array(passkey.public_key),
      counter: Number(passkey.counter),
      transports: transports(passkey.transports),
    },
  });
  if (!verification.verified) throw new Error("passkey_verification_failed");

  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const [consumed] = await connection.execute<ResultSetHeader>(
      `UPDATE auth_challenges SET consumed_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?) AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3)`,
      [challenge.id],
    );
    if (!consumed.affectedRows)
      throw new Error("invalid_or_expired_challenge");
    await connection.execute(
      "UPDATE user_passkeys SET counter=?,last_used_at=CURRENT_TIMESTAMP(3) WHERE credential_id=?",
      [verification.authenticationInfo.newCounter, passkey.credential_id],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { userId: passkey.user_id, verified: true };
}
