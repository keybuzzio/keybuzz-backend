import Fastify from "fastify";
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

async function bootstrap() {
  const app = Fastify({ logger: true });

  await app.register(cors);
  await app.register(helmet);

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

  registerHealthRoutes(app);
  registerTenantRoutes(app);
  registerAuthRoutes(app);
  registerTicketRoutes(app);
  registerTicketMessageRoutes(app);

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info(`KeyBuzz backend listening on port ${env.PORT}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

bootstrap();

