import type { FastifyRequest } from "fastify";

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
  actorIsPlatformAdmin?: boolean;
  supportUserId?: string;
  supportUserEmail?: string;
  supportUserDisplayName?: string;
};

export type AuthenticatedRequest = FastifyRequest & {
  sessionUser: SessionUser;
};
