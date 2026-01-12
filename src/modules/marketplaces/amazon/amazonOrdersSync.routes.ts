// src/modules/marketplaces/amazon/amazonOrdersSync.routes.ts
// PH15-AMAZON-ORDERS-SYNC-SCALE-01: Global multi-tenant sync endpoints

import type { FastifyInstance, FastifyRequest } from "fastify";
import { devAuthenticateOrJwt } from "../../../lib/devAuthMiddleware";
import type { AuthUser } from "../../auth/auth.types";
import { runOrdersDeltaSync, getSyncStatus, syncMissingItems } from "./amazonOrdersSync.service";
import { runGlobalOrdersSync, getGlobalSyncStatus } from "./amazonOrdersSyncGlobal.service";

export async function registerAmazonOrdersSyncRoutes(server: FastifyInstance) {
  const authenticate = devAuthenticateOrJwt;
  
  /**
   * GET /api/v1/orders/sync/status
   * Get sync status - global (all tenants) or single tenant
   */
  server.get<{ Querystring: { tenantId?: string } }>(
    "/api/v1/orders/sync/status",
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Querystring: { tenantId?: string } }>, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const { tenantId } = request.query;
      
      try {
        if (tenantId) {
          // Single tenant status
          const status = await getSyncStatus(tenantId);
          return reply.send(status);
        } else {
          // Global status - all CONNECTED tenants
          const statuses = await getGlobalSyncStatus();
          return reply.send({
            totalTenants: statuses.length,
            tenants: statuses,
          });
        }
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
   * Run sync - global (all tenants) or single tenant
   * If X-Tenant-Id header is provided, sync only that tenant
   * Otherwise, run global multi-tenant sync
   */
  server.post(
    "/api/v1/orders/sync/run",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      // Check if specific tenant requested via header or user context
      const tenantId = user.tenantId;
      
      // If tenantId is provided and not "global", sync single tenant
      if (tenantId && tenantId !== "global") {
        console.log(`[Sync Run] Single tenant sync for ${tenantId} by ${user.email}`);
        
        try {
          const result = await runOrdersDeltaSync(tenantId);
          return reply.send({
            mode: "single",
            tenantId,
            success: result.success,
            ordersProcessed: result.ordersProcessed,
            itemsProcessed: result.itemsProcessed,
            errors: result.errors.slice(0, 10),
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
      
      // Global sync - all tenants
      console.log(`[Sync Run] Global multi-tenant sync triggered by ${user.email}`);
      
      try {
        const result = await runGlobalOrdersSync();
        return reply.send({
          mode: "global",
          success: result.success,
          tenantsProcessed: result.tenantsProcessed,
          tenantsSkipped: result.tenantsSkipped,
          totalDuration: result.totalDuration,
          results: result.results,
        });
      } catch (error) {
        console.error("[Global Sync Run] Error:", error);
        return reply.status(500).send({ 
          error: "Global sync failed",
          details: (error as Error).message 
        });
      }
    }
  );
  
  /**
   * POST /api/v1/orders/sync/run/global
   * Explicit global sync endpoint (for CronJob)
   * Does not require X-Tenant-Id header
   */
  server.post(
    "/api/v1/orders/sync/run/global",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      console.log(`[Global Sync] Triggered by ${user.email}`);
      
      try {
        const result = await runGlobalOrdersSync();
        return reply.send({
          mode: "global",
          success: result.success,
          tenantsProcessed: result.tenantsProcessed,
          tenantsSkipped: result.tenantsSkipped,
          totalDuration: result.totalDuration,
          results: result.results,
        });
      } catch (error) {
        console.error("[Global Sync] Error:", error);
        return reply.status(500).send({ 
          error: "Global sync failed",
          details: (error as Error).message 
        });
      }
    }
  );
  
  /**
   * POST /api/v1/orders/sync/items
   * Sync missing items for orders (single tenant)
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