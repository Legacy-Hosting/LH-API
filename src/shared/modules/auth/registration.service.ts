import { randomUUID } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { env } from "../../../core/config/env.js";
import { database } from "../../../core/database/mysql.js";
import { safeTokenEqual, tokenHash, uuidToBytes } from "./auth.crypto.js";

type UserRow = RowDataPacket & {
  id: string;
  email: string;
  display_name: string;
  status: string;
};
type PasskeyRow = RowDataPacket & {
  credential_id: string;
  transports: string | string[] | null;
};
type InvitationRow = RowDataPacket & {
  id: string;
  team_id: string;
  role: "owner" | "administrator" | "developer" | "viewer";
};
type ChallengeRow = RowDataPacket & {
  id: string;
  user_id: string;
  challenge: string;
  context: string | Record<string, unknown> | null;
};

function jsonValue<T>(value: string | T | null): T | null {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function registrationStatus() {
  const [[countRow]] = await database().query<
    (RowDataPacket & { count: number })[]
  >("SELECT COUNT(*) AS count FROM users WHERE status='active'");
  const [[settingRow]] = await database().query<
    (RowDataPacket & {
      setting_value:
        | string
        | {
            mode?: "open" | "invite_only" | "closed";
            emailVerificationRequired?: boolean;
          };
    })[]
  >(
    "SELECT setting_value FROM platform_settings WHERE setting_key='registration' LIMIT 1",
  );
  const setting = jsonValue<{
    mode?: "open" | "invite_only" | "closed";
    emailVerificationRequired?: boolean;
  }>(settingRow?.setting_value ?? null);
  return {
    bootstrapRequired: Number(countRow?.count ?? 0) === 0,
    mode: setting?.mode ?? "closed",
    emailVerificationRequired: setting?.emailVerificationRequired ?? false,
  };
}

export async function beginRegistration(input: {
  email: string;
  displayName: string;
  invitationToken?: string;
  bootstrapToken?: string;
}) {
  const email = input.email.trim().toLowerCase();
  const status = await registrationStatus();
  let bootstrap = false;
  let invitation: InvitationRow | undefined;

  if (status.bootstrapRequired) {
    if (!safeTokenEqual(input.bootstrapToken, env.INITIAL_ADMIN_TOKEN))
      throw new Error("bootstrap_token_required");
    bootstrap = true;
  } else if (input.invitationToken) {
    const [rows] = await database().query<InvitationRow[]>(
      `SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(team_id) AS team_id, role
       FROM invitations WHERE token_hash=? AND email=? AND accepted_at IS NULL
         AND expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
      [tokenHash(input.invitationToken), email],
    );
    invitation = rows[0];
    if (!invitation) throw new Error("invalid_invitation");
  } else if (status.mode !== "open") {
    throw new Error(
      status.mode === "invite_only"
        ? "invitation_required"
        : "registration_closed",
    );
  }

  const [users] = await database().query<UserRow[]>(
    "SELECT BIN_TO_UUID(id) AS id, email, display_name, status FROM users WHERE email=? LIMIT 1",
    [email],
  );
  let user = users[0];
  if (user?.status === "active") throw new Error("account_exists");
  if (!user) {
    const id = randomUUID();
    await database().execute(
      `INSERT INTO users (id,email,display_name,status,is_platform_admin) VALUES (UUID_TO_BIN(?),?,?,'pending',?)`,
      [id, email, input.displayName.trim(), bootstrap],
    );
    user = {
      id,
      email,
      display_name: input.displayName.trim(),
      status: "pending",
    } as UserRow;
  }

  const [passkeys] = await database().query<PasskeyRow[]>(
    "SELECT credential_id, transports FROM user_passkeys WHERE user_id=UUID_TO_BIN(?)",
    [user.id],
  );
  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userID: uuidToBytes(user.id),
    userName: user.email,
    userDisplayName: user.display_name,
    attestationType: "none",
    excludeCredentials: passkeys.map((passkey) => ({
      id: passkey.credential_id,
      transports: jsonValue<string[]>(passkey.transports) ?? undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const challengeId = randomUUID();
  await database().execute(
    `INSERT INTO auth_challenges (id,user_id,ceremony,challenge,context,expires_at)
     VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'registration',?,?,CURRENT_TIMESTAMP(3)+INTERVAL 5 MINUTE)`,
    [
      challengeId,
      user.id,
      options.challenge,
      JSON.stringify({
        bootstrap,
        invitationId: invitation?.id ?? null,
        teamId: invitation?.team_id ?? null,
        role: invitation?.role ?? null,
      }),
    ],
  );
  return { challengeId, options };
}

export async function finishRegistration(input: {
  challengeId: string;
  response: RegistrationResponseJSON;
  deviceName?: string;
}) {
  const [rows] = await database().query<ChallengeRow[]>(
    `SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(user_id) AS user_id, challenge, context
     FROM auth_challenges WHERE id=UUID_TO_BIN(?) AND ceremony='registration'
       AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3) LIMIT 1`,
    [input.challengeId],
  );
  const challenge = rows[0];
  if (!challenge) throw new Error("invalid_or_expired_challenge");

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo)
    throw new Error("passkey_verification_failed");

  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;
  const context =
    jsonValue<{
      bootstrap?: boolean;
      invitationId?: string | null;
      teamId?: string | null;
      role?: string | null;
    }>(challenge.context) ?? {};
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO user_passkeys
       (id,user_id,webauthn_user_id,credential_id,public_key,counter,device_type,backed_up,transports,device_name)
       VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?,?,?,?,?,?,?,?)`,
      [
        randomUUID(),
        challenge.user_id,
        uuidToBytes(challenge.user_id),
        credential.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp,
        JSON.stringify(credential.transports ?? []),
        input.deviceName?.slice(0, 100) ?? "Passkey",
      ],
    );
    await connection.execute(
      `UPDATE users SET status='active',is_platform_admin=? WHERE id=UUID_TO_BIN(?)`,
      [Boolean(context.bootstrap), challenge.user_id],
    );

    if (context.teamId && context.invitationId) {
      await connection.execute(
        "INSERT INTO team_members (team_id,user_id,role) VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),?)",
        [context.teamId, challenge.user_id, context.role ?? "viewer"],
      );
      await connection.execute(
        "UPDATE invitations SET accepted_at=CURRENT_TIMESTAMP(3) WHERE id=UUID_TO_BIN(?)",
        [context.invitationId],
      );
    } else {
      const [[user]] = await connection.query<UserRow[]>(
        "SELECT email,display_name FROM users WHERE id=UUID_TO_BIN(?)",
        [challenge.user_id],
      );
      const teamId = randomUUID();
      const slug = `${user!.email
        .split("@")[0]!
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40)}-${randomUUID().slice(0, 8)}`;
      await connection.execute(
        "INSERT INTO teams (id,name,slug) VALUES (UUID_TO_BIN(?),?,?)",
        [teamId, `${user!.display_name}'s team`, slug],
      );
      await connection.execute(
        "INSERT INTO team_members (team_id,user_id,role) VALUES (UUID_TO_BIN(?),UUID_TO_BIN(?),'owner')",
        [teamId, challenge.user_id],
      );
    }
    const [consumed] = await connection.execute<ResultSetHeader>(
      `UPDATE auth_challenges SET consumed_at=CURRENT_TIMESTAMP(3)
       WHERE id=UUID_TO_BIN(?) AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP(3)`,
      [challenge.id],
    );
    if (!consumed.affectedRows)
      throw new Error("invalid_or_expired_challenge");
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { userId: challenge.user_id, verified: true };
}
