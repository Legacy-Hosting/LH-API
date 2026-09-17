import type { FastifyPluginAsync } from "fastify";
import { subscriptionRoutes } from "./modules/subscriptions/subscription.routes.js";

export const billingProduct: FastifyPluginAsync = async (app) => {
  await app.register(subscriptionRoutes);
};
