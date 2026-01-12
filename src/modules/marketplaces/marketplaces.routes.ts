// src/modules/marketplaces/marketplaces.routes.ts

import type { FastifyInstance } from "fastify";
import { registerAmazonRoutes } from "./amazon/amazon.routes";
import { registerAmazonReplyRoutes } from "./amazon/amazonReply.routes";
import { registerAmazonOrdersRoutes } from "./amazon/amazonOrders.routes";
import { registerAmazonOrdersSyncRoutes } from "./amazon/amazonOrdersSync.routes";
import { registerAmazonReportsRoutes } from "./amazon/amazonReports.routes";

export async function registerMarketplaceRoutes(server: FastifyInstance) {
  // Register Amazon routes (authenticated)
  await registerAmazonRoutes(server);
  
  // PH15: Amazon Orders routes
  await registerAmazonOrdersRoutes(server);
  
  // PH15-AMAZON-ORDERS-SYNC-01: Sync status and manual trigger
  await registerAmazonOrdersSyncRoutes(server);
  
  // PH15-TRACKING-REPORTS-02: Reports API for tracking
  await registerAmazonReportsRoutes(server);

  // TODO: Register other marketplace routes (Fnac, Cdiscount, etc.)
}

export async function registerPublicMarketplaceRoutes(server: FastifyInstance) {
  // Public routes (no JWT) - OAuth callbacks
}

export { registerAmazonReplyRoutes };
