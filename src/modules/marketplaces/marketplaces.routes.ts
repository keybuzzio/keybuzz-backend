// src/modules/marketplaces/marketplaces.routes.ts

import type { FastifyInstance } from "fastify";
import { registerAmazonRoutes, registerAmazonOAuthCallbackRoute } from "./amazon/amazon.routes";
import { registerAmazonReplyRoutes } from "./amazon/amazonReply.routes";

export async function registerMarketplaceRoutes(server: FastifyInstance) {
  // Register Amazon routes (authenticated)
  await registerAmazonRoutes(server);

  // TODO: Register other marketplace routes (Fnac, Cdiscount, etc.)
}

export async function registerPublicMarketplaceRoutes(server: FastifyInstance) {
  // Public routes (no JWT) - OAuth callbacks
  await registerAmazonOAuthCallbackRoute(server);
}

export { registerAmazonReplyRoutes };
