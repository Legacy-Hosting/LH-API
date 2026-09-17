import type { FastifyPluginAsync } from "fastify";

export type ProductModule = {
  name: string;
  routes: FastifyPluginAsync;
};
