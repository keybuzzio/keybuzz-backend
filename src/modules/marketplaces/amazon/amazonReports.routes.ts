// src/modules/marketplaces/amazon/amazonReports.routes.ts
// PH15-TRACKING-REPORTS-02: Routes for Reports API sync

import { FastifyInstance } from "fastify";
import {
  runReportsSyncForTenant,
  runGlobalReportsSync,
  getReportsSyncStatus,
  getReportsEligibleTenants,
} from "./amazonReports.service";

export async function registerAmazonReportsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/orders/sync/reports/status - Global status
  fastify.get("/api/v1/orders/sync/reports/status", async (request, reply) => {
    try {
      const tenantId = request.headers["x-tenant-id"] as string | undefined;

      if (tenantId) {
        // Return status for specific tenant
        const allStatus = await getReportsSyncStatus();
        const status = allStatus.find(s => s.tenantId === tenantId);
        return reply.send({
          tenantId,
          status: status || { lastSuccessAt: null, lastError: "No sync yet", rowsProcessed: 0, ordersUpdated: 0 },
        });
      }

      // Return global status
      const eligible = await getReportsEligibleTenants();
      const statuses = await getReportsSyncStatus();

      return reply.send({
        eligibleTenants: eligible.length,
        syncedTenants: statuses.length,
        tenants: statuses,
      });
    } catch (error) {
      console.error("[Reports Routes] Status error:", error);
      return reply.status(500).send({
        error: "Failed to get reports sync status",
        message: (error as Error).message,
      });
    }
  });

  // POST /api/v1/orders/sync/reports/run - Trigger manual sync
  fastify.post("/api/v1/orders/sync/reports/run", async (request, reply) => {
    try {
      const tenantId = request.headers["x-tenant-id"] as string | undefined;
      const body = request.body as { days?: number; global?: boolean } | undefined;
      const days = body?.days || 30;

      // If global flag or no tenant specified, run global sync
      if (body?.global || !tenantId) {
        console.log(`[Reports Routes] Running global reports sync (${days} days)`);
        const result = await runGlobalReportsSync(days);
        return reply.send(result);
      }

      // Run for specific tenant
      console.log(`[Reports Routes] Running reports sync for ${tenantId} (${days} days)`);
      const result = await runReportsSyncForTenant(tenantId, days);
      return reply.send(result);
    } catch (error) {
      console.error("[Reports Routes] Run error:", error);
      return reply.status(500).send({
        error: "Failed to run reports sync",
        message: (error as Error).message,
      });
    }
  });

  // GET /api/v1/orders/sync/reports/eligible - List eligible tenants
  fastify.get("/api/v1/orders/sync/reports/eligible", async (_request, reply) => {
    try {
      const tenants = await getReportsEligibleTenants();
      return reply.send({ tenants, count: tenants.length });
    } catch (error) {
      console.error("[Reports Routes] Eligible error:", error);
      return reply.status(500).send({
        error: "Failed to get eligible tenants",
        message: (error as Error).message,
      });
    }
  });
}
