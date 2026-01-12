// src/modules/marketplaces/amazon/amazonOrders.routes.ts
// PH15-ORDERS-UI-SEARCH-01: Amazon Orders routes with search

import type { FastifyInstance, FastifyRequest } from "fastify";
import { devAuthenticateOrJwt } from "../../../lib/devAuthMiddleware";
import { backfillAmazonOrders, getOrdersForTenant, getOrderById, countOrdersForTenant } from "./amazonOrders.service";
import type { AuthUser } from "../../auth/auth.types";

interface OrdersQueryParams {
  limit?: string;
  offset?: string;
  q?: string;  // Search by orderId
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export async function registerAmazonOrdersRoutes(server: FastifyInstance) {
  const authenticate = devAuthenticateOrJwt;
  
  /**
   * GET /api/v1/orders
   * List orders for current tenant with search and filters
   */
  server.get<{ Querystring: OrdersQueryParams }>(
    "/api/v1/orders",
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Querystring: OrdersQueryParams }>, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const { limit: limitStr, offset: offsetStr, q, status, dateFrom, dateTo } = request.query;
      const limit = Math.min(parseInt(limitStr || "50"), 100);
      const offset = parseInt(offsetStr || "0");
      
      try {
        const [orders, total] = await Promise.all([
          getOrdersForTenant({
            tenantId: user.tenantId,
            limit,
            offset,
            search: q?.trim(),
            status,
            dateFrom: dateFrom ? new Date(dateFrom) : undefined,
            dateTo: dateTo ? new Date(dateTo) : undefined,
          }),
          countOrdersForTenant({
            tenantId: user.tenantId,
            search: q?.trim(),
            status,
            dateFrom: dateFrom ? new Date(dateFrom) : undefined,
            dateTo: dateTo ? new Date(dateTo) : undefined,
          }),
        ]);
        
        return reply.send({ 
          orders, 
          count: orders.length,
          total,
          pagination: {
            limit,
            offset,
            hasMore: offset + orders.length < total,
          },
        });
      } catch (error) {
        console.error("[Orders] List error:", error);
        return reply.status(500).send({ error: "Failed to list orders" });
      }
    }
  );
  
  /**
   * GET /api/v1/orders/:orderId
   * Get single order detail
   */
  server.get<{ Params: { orderId: string } }>(
    "/api/v1/orders/:orderId",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const { orderId } = request.params;
      
      try {
        const order = await getOrderById({
          tenantId: user.tenantId,
          orderId,
        });
        
        if (!order) {
          return reply.status(404).send({ error: "Order not found" });
        }
        
        return reply.send(order);
      } catch (error) {
        console.error("[Orders] Get detail error:", error);
        return reply.status(500).send({ error: "Failed to get order" });
      }
    }
  );
  
  /**
   * POST /api/v1/orders/backfill
   * Backfill Amazon orders
   */
  server.post(
    "/api/v1/orders/backfill",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const body = request.body as { days?: number };
      const days = Math.min(body.days || 90, 365);
      
      console.log(`[Orders Backfill] Starting ${days}-day backfill for ${user.tenantId}`);
      
      try {
        const result = await backfillAmazonOrders({
          tenantId: user.tenantId,
          days,
          onProgress: (count) => console.log(`[Orders Backfill] Progress: ${count}`),
        });
        
        return reply.send({
          success: true,
          imported: result.imported,
          errors: result.errors.slice(0, 10),
        });
      } catch (error) {
        console.error("[Orders Backfill] Error:", error);
        return reply.status(500).send({
          error: "Backfill failed",
          details: (error as Error).message,
        });
      }
    }
  );
}