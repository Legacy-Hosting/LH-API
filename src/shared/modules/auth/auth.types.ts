import type { FastifyRequest } from "fastify";

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  isPlatformAdmin: boolean;
};

export type AuthenticatedRequest = FastifyRequest & {
  sessionUser: SessionUser;
};
