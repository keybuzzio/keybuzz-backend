// src/modules/marketplaces/marketplaces.routes.ts

import type { FastifyInstance } from "fastify";
import { registerAmazonRoutes } from "./amazon/amazon.routes";

export async function registerMarketplaceRoutes(server: FastifyInstance) {
  // Register Amazon routes
  await registerAmazonRoutes(server);

  // TODO: Register other marketplace routes (Fnac, Cdiscount, etc.)
}

