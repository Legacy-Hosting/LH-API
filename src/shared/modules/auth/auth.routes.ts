import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { database } from "../../../core/database/mysql.js";
import { requirePlatformAdmin, requireSession } from "./auth.guard.js";
import {
  beginAuthentication,
  finishAuthentication,
} from "./authentication.service.js";
import {
  beginRegistration,
  finishRegistration,
  registrationStatus,
} from "./registration.service.js";
import {
  createSession,
  resolveSession,
  revokeSession,
  SESSION_COOKIE_NAME,
} from "./session.service.js";
import { createCsrfToken } from "../../security/csrf.js";
import type { AuthenticatedRequest } from "./auth.types.js";
import { createSsoLoginTicket, SsoBridgeError } from "./sso-bridge.service.js";

const passkeyResponse = z.object({ id: z.string().min(1) }).passthrough();
const registerOptionsBody = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(100),
  invitationToken: z.string().min(20).optional(),
  bootstrapToken: z.string().min(20).optional(),
});
const verifyRegistrationBody = z.object({
  challengeId: z.string().uuid(),
  response: passkeyResponse,
  deviceName: z.string().max(100).optional(),
});
const loginOptionsBody = z.object({
  email: z.string().trim().email().max(254).optional(),
});
const verifyAuthenticationBody = z.object({
  challengeId: z.string().uuid(),
  response: passkeyResponse,
});
const registrationSettingBody = z.object({
  mode: z.enum(["open", "invite_only", "closed"]),
  emailVerificationRequired: z.boolean().default(false),
});
const continueSsoBody = z.object({
  interactionUid: z.string().regex(/^[A-Za-z0-9_-]{16,255}$/),
});

function errorStatus(message: string) {
  if (["account_exists"].includes(message)) return 409;
  if (
    [
      "registration_closed",
      "invitation_required",
      "invalid_invitation",
      "bootstrap_token_required",
    ].includes(message)
  )
    return 403;
  if (["account_not_found", "unknown_passkey"].includes(message)) return 404;
  return 400;
}

async function guarded<T>(reply: FastifyReply, action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "authentication_failed";
    return reply.status(errorStatus(message)).send({ error: message });
  }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get("/registration", async () => ({ data: await registrationStatus() }));

  app.post("/register/options", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = registerOptionsBody.safeParse(request.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: body.error.flatten() });
    return guarded(reply, async () => ({
      data: await beginRegistration(body.data),
    }));
  });

  app.post("/register/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = verifyRegistrationBody.safeParse(request.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: body.error.flatten() });
    return guarded(reply, async () => {
      const result = await finishRegistration({
        ...body.data,
        response: body.data.response as unknown as RegistrationResponseJSON,
      });
      await createSession(result.userId, request, reply);
      return { data: { verified: true } };
    });
  });

  app.post("/login/options", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginOptionsBody.safeParse(request.body ?? {});
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: body.error.flatten() });
    return guarded(reply, async () => ({
      data: await beginAuthentication(body.data.email),
    }));
  });

  app.post("/login/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = verifyAuthenticationBody.safeParse(request.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "validation_error", details: body.error.flatten() });
    return guarded(reply, async () => {
      const result = await finishAuthentication({
        ...body.data,
        response: body.data.response as unknown as AuthenticationResponseJSON,
      });
      await createSession(result.userId, request, reply);
      return { data: { verified: true } };
    });
  });

  app.get("/me", { preHandler: requireSession }, async (request, reply) => {
    const user = await resolveSession(request);
    if (!user)
      return reply.status(401).send({ error: "authentication_required" });
    const [memberships] = await database().query<
      (RowDataPacket & {
        id: string;
        name: string;
        slug: string;
        role: string;
      })[]
    >(
      `SELECT BIN_TO_UUID(t.id) AS id,t.name,t.slug,tm.role FROM team_members tm
       JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=UUID_TO_BIN(?) ORDER BY t.name`,
      [user.id],
    );
    return { data: { ...user, teams: memberships } };
  });

  app.get("/csrf", { preHandler: requireSession }, async (request, reply) => {
    const sessionToken = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionToken)
      return reply.status(401).send({ error: "authentication_required" });
    return {
      data: { token: createCsrfToken(sessionToken) },
    };
  });

  app.post("/sso/continue", { preHandler: requireSession }, async (request, reply) => {
    const body = continueSsoBody.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "validation_error" });
    const user = (request as AuthenticatedRequest).sessionUser;
    try {
      const ticket = await createSsoLoginTicket({
        interactionUid: body.data.interactionUid,
        subject: user.id,
        email: user.email,
        displayName: user.displayName,
      });
      return reply.header("Cache-Control", "no-store").send({ data: ticket });
    } catch (error) {
      if (error instanceof SsoBridgeError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/logout", async (request, reply) => {
    await revokeSession(request, reply);
    return reply.status(204).send();
  });

  app.get(
    "/admin/users",
    { preHandler: requirePlatformAdmin },
    async () => {
      const [users, memberships] = await Promise.all([
        database().query<
          (RowDataPacket & {
            id: string;
            email: string;
            displayName: string;
            status: string;
            isPlatformAdmin: number;
            createdAt: Date;
          })[]
        >(
          `SELECT BIN_TO_UUID(id) AS id,email,display_name AS displayName,status,
                  is_platform_admin AS isPlatformAdmin,created_at AS createdAt
           FROM users ORDER BY created_at DESC`,
        ),
        database().query<
          (RowDataPacket & {
            userId: string;
            id: string;
            name: string;
            slug: string;
            role: string;
          })[]
        >(
          `SELECT BIN_TO_UUID(tm.user_id) AS userId,BIN_TO_UUID(t.id) AS id,
                  t.name,t.slug,tm.role
           FROM team_members tm JOIN teams t ON t.id=tm.team_id
           ORDER BY t.name`,
        ),
      ]);
      const teamsByUser = new Map<string, typeof memberships[0]>();
      for (const membership of memberships[0]) {
        const teams = teamsByUser.get(membership.userId) ?? [];
        teams.push(membership);
        teamsByUser.set(membership.userId, teams);
      }
      return {
        data: users[0].map((user) => ({
          ...user,
          isPlatformAdmin: Boolean(user.isPlatformAdmin),
          teams: (teamsByUser.get(user.id) ?? []).map(
            ({ userId: _userId, ...team }) => team,
          ),
        })),
      };
    },
  );

  app.get(
    "/admin/registration",
    { preHandler: requirePlatformAdmin },
    async () => ({ data: await registrationStatus() }),
  );
  app.put(
    "/admin/registration",
    { preHandler: requirePlatformAdmin },
    async (request, reply) => {
      const body = registrationSettingBody.safeParse(request.body);
      if (!body.success)
        return reply
          .status(400)
          .send({ error: "validation_error", details: body.error.flatten() });
      await database().execute(
        `INSERT INTO platform_settings (setting_key,setting_value,updated_at)
       VALUES ('registration',?,CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=CURRENT_TIMESTAMP(3)`,
        [JSON.stringify(body.data)],
      );
      return { data: body.data };
    },
  );
};
