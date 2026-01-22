// src/modules/marketplaces/amazon/amazonOrdersSync.routes.ts
// PH15-AMAZON-ORDERS-SYNC-SCALE-02: Hardened global sync endpoints

import type { FastifyInstance, FastifyRequest } from "fastify";
import { devAuthenticateOrJwt } from "../../../lib/devAuthMiddleware";
import type { AuthUser } from "../../auth/auth.types";
import { runOrdersDeltaSync, getSyncStatus, syncMissingItems } from "./amazonOrdersSync.service";
import { runGlobalOrdersSync, getGlobalSyncStatus, SyncReasonCode } from "./amazonOrdersSyncGlobal.service";

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
          const status = await getSyncStatus(tenantId);
          return reply.send(status);
        } else {
          const statuses = await getGlobalSyncStatus();
          return reply.send({
            totalTenants: statuses.length,
            tenantsWithToken: statuses.filter(s => s.hasRefreshToken).length,
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
   * Run sync for a specific tenant (requires X-Tenant-Id)
   */
  server.post(
    "/api/v1/orders/sync/run",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const tenantId = user.tenantId;
      
      if (!tenantId || tenantId === "global") {
        return reply.status(400).send({ 
          error: "X-Tenant-Id required for single tenant sync. Use /sync/run/global for multi-tenant." 
        });
      }
      
      console.log(`[Sync Run] Single tenant: ${tenantId} by ${user.email}`);
      
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
  );
  
  /**
   * POST /api/v1/orders/sync/run/global
   * Run global multi-tenant sync (for CronJob)
   * Hardened: skips tenants without valid credentials
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
          summary: result.summary,
          totalDuration: result.totalDuration,
          results: result.results.map(r => ({
            tenantId: r.tenantId,
            status: r.status,
            reasonCode: r.reasonCode,
            ordersProcessed: r.ordersProcessed,
            itemsProcessed: r.itemsProcessed,
            message: r.message,
          })),
          reasonCodes: Object.values(SyncReasonCode),
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
      
      console.log(`[Items Sync] Trigger for ${user.tenantId}`);
      
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
  /**
   * GET /api/v1/orders/sync/backfill/status
   * Get backfill status for a tenant
   * PH15.2-AMAZON-ORDERS-BACKFILL-365D-01
   */
  server.get<{ Querystring: { tenantId?: string } }>(
    "/api/v1/orders/sync/backfill/status",
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Querystring: { tenantId?: string } }>, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const tenantId = request.query.tenantId || user.tenantId;
      
      if (!tenantId) {
        return reply.status(400).send({ error: "tenantId required" });
      }
      
      try {
        const { getBackfillStatus } = await import("./amazonOrdersBackfill.service");
        const status = await getBackfillStatus(tenantId);
        return reply.send(status);
      } catch (error) {
        console.error("[Backfill Status] Error:", error);
        return reply.status(500).send({ 
          error: "Failed to get backfill status",
          details: (error as Error).message 
        });
      }
    }
  );

  /**
   * POST /api/v1/orders/sync/backfill/run
   * Manually trigger initial backfill for a tenant
   * PH15.2-AMAZON-ORDERS-BACKFILL-365D-01
   */
  server.post<{ Querystring: { tenantId?: string; days?: string } }>(
    "/api/v1/orders/sync/backfill/run",
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Querystring: { tenantId?: string; days?: string } }>, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const tenantId = request.query.tenantId || user.tenantId;
      const days = parseInt(request.query.days || "365", 10);
      
      if (!tenantId) {
        return reply.status(400).send({ error: "tenantId required" });
      }
      
      if (days < 1 || days > 730) {
        return reply.status(400).send({ error: "days must be between 1 and 730" });
      }
      
      console.log(`[Backfill Run] Manual trigger for ${tenantId}, ${days} days by ${user.email}`);
      
      try {
        const { runInitialBackfill } = await import("./amazonOrdersBackfill.service");
        const result = await runInitialBackfill(tenantId, days);
        
        return reply.send({
          success: result.success,
          tenantId: result.tenantId,
          daysBackfilled: result.daysBackfilled,
          ordersProcessed: result.ordersProcessed,
          itemsProcessed: result.itemsProcessed,
          durationMs: result.durationMs,
          errors: result.errors.slice(0, 10),
        });
      } catch (error) {
        console.error("[Backfill Run] Error:", error);
        return reply.status(500).send({ 
          error: "Backfill failed",
          details: (error as Error).message 
        });
      }
    }
  );
}