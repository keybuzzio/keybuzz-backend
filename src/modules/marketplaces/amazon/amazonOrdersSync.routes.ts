// src/modules/marketplaces/amazon/amazonOrdersSync.routes.ts
// PH15-AMAZON-ORDERS-SYNC-01: Sync status and manual trigger endpoints

import type { FastifyInstance, FastifyRequest } from "fastify";
import { devAuthenticateOrJwt } from "../../../lib/devAuthMiddleware";
import type { AuthUser } from "../../auth/auth.types";
import { runOrdersDeltaSync, getSyncStatus, syncMissingItems } from "./amazonOrdersSync.service";

export async function registerAmazonOrdersSyncRoutes(server: FastifyInstance) {
  const authenticate = devAuthenticateOrJwt;
  
  /**
   * GET /api/v1/orders/sync/status
   * Get sync status for the current tenant
   */
  server.get(
    "/api/v1/orders/sync/status",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      try {
        const status = await getSyncStatus(user.tenantId);
        return reply.send(status);
      } catch (error) {
        console.error("[Sync Status] Error:", error);
        return reply.status(500).send({ 
          error: "Failed to get sync status",
          details: (error as Error).message 
        });
      }
    }
  );
  
  /**
   * POST /api/v1/orders/sync/run
   * Manually trigger a delta sync (DEV only)
   */
  server.post(
    "/api/v1/orders/sync/run",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      console.log(`[Sync Run] Manual trigger for tenant ${user.tenantId} by ${user.email}`);
      
      try {
        const result = await runOrdersDeltaSync(user.tenantId);
        return reply.send({
          success: result.success,
          ordersProcessed: result.ordersProcessed,
          itemsProcessed: result.itemsProcessed,
          errors: result.errors.slice(0, 10), // Limit errors in response
          lastUpdatedAfter: result.lastUpdatedAfter,
        });
      } catch (error) {
        console.error("[Sync Run] Error:", error);
        return reply.status(500).send({ 
          error: "Sync failed",
          details: (error as Error).message 
        });
      }
    }
  );
  
  /**
   * POST /api/v1/orders/sync/items
   * Sync missing items for orders (DEV only)
   */
  server.post(
    "/api/v1/orders/sync/items",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      console.log(`[Items Sync] Manual trigger for tenant ${user.tenantId}`);
      
      try {
        const result = await syncMissingItems(user.tenantId);
        return reply.send({
          success: true,
          processed: result.processed,
          errors: result.errors.slice(0, 10),
        });
      } catch (error) {
        console.error("[Items Sync] Error:", error);
        return reply.status(500).send({ 
          error: "Items sync failed",
          details: (error as Error).message 
        });
      }
    }
  );
}