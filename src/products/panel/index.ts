import type { FastifyPluginAsync } from "fastify";
import { requireSession } from "../../shared/modules/auth/auth.guard.js";
import { requireTeam } from "../../shared/modules/teams/team.context.js";
import { applicationRoutes } from "./modules/applications/application.routes.js";
import { deploymentRoutes } from "./modules/deployments/deployment.routes.js";
import { domainRoutes } from "./modules/domains/domain.routes.js";
import { nodeRoutes } from "./modules/nodes/node.routes.js";
import { overviewRoutes } from "./modules/overview/overview.routes.js";
import { notificationRoutes } from "./modules/notifications/notification.routes.js";
import { monitoringRoutes } from "./modules/monitoring/monitoring.routes.js";

export const panelProduct: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireSession);
  app.addHook("preHandler", requireTeam);
  await app.register(overviewRoutes);
  await app.register(applicationRoutes);
  await app.register(nodeRoutes);
  await app.register(domainRoutes);
  await app.register(deploymentRoutes);
  await app.register(notificationRoutes);
  await app.register(monitoringRoutes);
};
