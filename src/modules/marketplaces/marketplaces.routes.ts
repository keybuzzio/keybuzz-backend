// src/modules/marketplaces/marketplaces.routes.ts

import type { FastifyInstance } from "fastify";
import { registerAmazonRoutes } from "./amazon/amazon.routes";
import { registerAmazonReplyRoutes } from "./amazon/amazonReply.routes";
import { registerAmazonOrdersRoutes } from "./amazon/amazonOrders.routes";

export async function registerMarketplaceRoutes(server: FastifyInstance) {
  // Register Amazon routes (authenticated)
  await registerAmazonRoutes(server);
  
  // PH15: Amazon Orders routes
  await registerAmazonOrdersRoutes(server);

  // TODO: Register other marketplace routes (Fnac, Cdiscount, etc.)
}

export async function registerPublicMarketplaceRoutes(server: FastifyInstance) {
  // Public routes (no JWT) - OAuth callbacks
}

export { registerAmazonReplyRoutes };