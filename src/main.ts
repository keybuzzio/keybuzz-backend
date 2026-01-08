import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { registerHealthRoutes } from "./modules/health/health.routes";
import { registerTenantRoutes } from "./modules/tenants/tenants.routes";
import { registerAuthRoutes } from "./modules/auth/auth.routes";
import { registerTicketRoutes } from "./modules/tickets/tickets.routes";
import { registerTicketMessageRoutes } from "./modules/tickets/messages.routes";
import { registerAiTestRoutes } from "./modules/ai/ai.routes";
import { registerMarketplaceRoutes, registerPublicMarketplaceRoutes, registerAmazonReplyRoutes } from "./modules/marketplaces/marketplaces.routes";
import { registerInboundRoutes } from "./modules/inbound/inbound.routes";
import { registerInboundEmailWebhookRoutes } from "./modules/webhooks/inboundEmailWebhook.routes";
import { registerInboundEmailRoutes } from "./modules/inboundEmail/inboundEmail.routes";
import { registerOutboundRoutes } from "./modules/outbound/outbound.routes";
import { registerOpsRoutes } from './modules/ops/ops.routes';
import { registerTenantSyncRoutes } from "./modules/tenants/tenantSync.routes";

async function bootstrap() {
  const app = Fastify({ 
    logger: true,
    bodyLimit: 1048576, // 1MB
  });

  // Register CORS and Helmet
  await app.register(cors);
  await app.register(helmet);

  // Register JWT plugin
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET || "fallback-secret-change-me"
  });

  // Register Swagger
  await app.register(swagger, {
    openapi: {
      info: {
        title: "KeyBuzz Backend API",
        version: "0.1.0",
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // ========================================
  // PUBLIC ROUTES (no JWT required)
  // ========================================
  await registerInboundEmailWebhookRoutes(app);
  await registerPublicMarketplaceRoutes(app);
  registerHealthRoutes(app);

  // ========================================
  // AUTHENTICATED ROUTES (JWT required)
  // ========================================
  registerTenantRoutes(app);
  registerAuthRoutes(app);
  registerTicketRoutes(app);
  registerTicketMessageRoutes(app);
  registerAiTestRoutes(app);
  await registerMarketplaceRoutes(app);
  await registerAmazonReplyRoutes(app);
  await registerInboundRoutes(app);
  await registerInboundEmailRoutes(app);
  await registerOutboundRoutes(app);
  await registerOpsRoutes(app);
  await registerTenantSyncRoutes(app);

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info(`KeyBuzz backend listening on port ${env.PORT}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

bootstrap();
