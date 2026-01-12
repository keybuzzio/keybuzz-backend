// src/modules/marketplaces/amazon/amazonOrders.routes.ts
// PH15-TRACKING-PROVENANCE-AUDIT-01: Amazon Orders routes with debug

import type { FastifyInstance, FastifyRequest } from "fastify";
import { devAuthenticateOrJwt } from "../../../lib/devAuthMiddleware";
import { backfillAmazonOrders, getOrdersForTenant, getOrderById, countOrdersForTenant } from "./amazonOrders.service";
import { getAmazonTenantCredentials } from "./amazon.vault";
import { getAccessToken } from "./amazon.tokens";
import type { AuthUser } from "../../auth/auth.types";

interface OrdersQueryParams {
  limit?: string;
  offset?: string;
  q?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

const SPAPI_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com";

export async function registerAmazonOrdersRoutes(server: FastifyInstance) {
  const authenticate = devAuthenticateOrJwt;
  
  // DEBUG: Get raw SP-API order fields
  server.get(
    "/api/v1/orders/debug/spapi-raw",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user?.tenantId) return reply.status(401).send({ error: "No tenant" });
      
      try {
        const creds = await getAmazonTenantCredentials(user.tenantId);
        if (!creds?.refresh_token) return reply.send({ error: "No Amazon credentials" });
        
        const accessToken = await getAccessToken(creds.refresh_token);
        const marketplaceId = creds.marketplace_id || "A13V1IB3VIYZZH";
        
        // Fetch recent orders (last 30 days, no status filter)
        const createdAfter = new Date();
        createdAfter.setDate(createdAfter.getDate() - 90);
        const url = `${SPAPI_ENDPOINT}/orders/v0/orders?MarketplaceIds=${marketplaceId}&CreatedAfter=${createdAfter.toISOString()}&MaxResultsPerPage=5`;
        
        console.log("[DEBUG] Fetching SP-API orders:", url);
        
        const resp = await fetch(url, {
          headers: {
            "x-amz-access-token": accessToken,
            "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
          },
        });
        
        if (!resp.ok) {
          const errorText = await resp.text();
          return reply.send({ error: `SP-API error ${resp.status}`, details: errorText.substring(0, 500) });
        }
        
        const data = await resp.json();
        const orders = data.payload?.Orders || [];
        
        // Mask PII but keep all other fields
        const maskedOrders = orders.map((o: any) => {
          const masked = { ...o };
          if (masked.BuyerInfo) masked.BuyerInfo = { _masked: true };
          if (masked.ShippingAddress) {
            masked.ShippingAddress = { 
              Name: "***MASKED***", 
              City: masked.ShippingAddress?.City, 
              StateOrRegion: masked.ShippingAddress?.StateOrRegion,
              CountryCode: masked.ShippingAddress?.CountryCode 
            };
          }
          return masked;
        });
        
        return reply.send({
          orderCount: orders.length,
          allFieldsInOrder: orders[0] ? Object.keys(orders[0]).sort() : [],
          shipmentRelatedFields: orders[0] ? Object.keys(orders[0]).filter((k: string) => 
            k.toLowerCase().includes("ship") || 
            k.toLowerCase().includes("carrier") || 
            k.toLowerCase().includes("track") ||
            k.toLowerCase().includes("fulfil")
          ) : [],
          sampleOrders: maskedOrders,
        });
      } catch (err) {
        console.error("[DEBUG] Error:", err);
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );
  
  // GET /api/v1/orders
  server.get<{ Querystring: OrdersQueryParams }>(
    "/api/v1/orders",
    { preHandler: authenticate },
    async (request: FastifyRequest<{ Querystring: OrdersQueryParams }>, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user || !user.tenantId) return reply.status(401).send({ error: "Unauthorized" });
      
      const { limit: limitStr, offset: offsetStr, q, status, dateFrom, dateTo } = request.query;
      const limit = Math.min(parseInt(limitStr || "50"), 100);
      const offset = parseInt(offsetStr || "0");
      
      try {
        const [orders, total] = await Promise.all([
          getOrdersForTenant({ tenantId: user.tenantId, limit, offset, search: q?.trim(), status, dateFrom: dateFrom ? new Date(dateFrom) : undefined, dateTo: dateTo ? new Date(dateTo) : undefined }),
          countOrdersForTenant({ tenantId: user.tenantId, search: q?.trim(), status, dateFrom: dateFrom ? new Date(dateFrom) : undefined, dateTo: dateTo ? new Date(dateTo) : undefined }),
        ]);
        return reply.send({ orders, count: orders.length, total, pagination: { limit, offset, hasMore: offset + orders.length < total } });
      } catch (error) {
        console.error("[Orders] List error:", error);
        return reply.status(500).send({ error: "Failed to list orders" });
      }
    }
  );
  
  // GET /api/v1/orders/:orderId
  server.get<{ Params: { orderId: string } }>(
    "/api/v1/orders/:orderId",
    { preHandler: authenticate },
    async (request, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user || !user.tenantId) return reply.status(401).send({ error: "Unauthorized" });
      
      const { orderId } = request.params;
      try {
        const order = await getOrderById({ tenantId: user.tenantId, orderId });
        if (!order) return reply.status(404).send({ error: "Order not found" });
        return reply.send(order);
      } catch (error) {
        console.error("[Orders] Get detail error:", error);
        return reply.status(500).send({ error: "Failed to get order" });
      }
    }
  );
  
  // POST /api/v1/orders/backfill
  server.post(
    "/api/v1/orders/backfill",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      if (!user || !user.tenantId) return reply.status(401).send({ error: "Unauthorized" });
      
      const body = request.body as { days?: number };
      const days = Math.min(body.days || 90, 365);
      
      console.log(`[Orders Backfill] Starting ${days}-day backfill for ${user.tenantId}`);
      try {
        const result = await backfillAmazonOrders({ tenantId: user.tenantId, days, onProgress: (count) => console.log(`[Orders Backfill] Progress: ${count}`) });
        return reply.send({ success: true, imported: result.imported, errors: result.errors.slice(0, 10) });
      } catch (error) {
        console.error("[Orders Backfill] Error:", error);
        return reply.status(500).send({ error: "Backfill failed", details: (error as Error).message });
      }
    }
  );
}