// src/modules/marketplaces/amazon/amazonFees.routes.ts
// PH15-AMAZON-COMMISSION-RATES: Internal API for commission rates

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getCommissionRates,
  validateInternalToken,
  CommissionRateRequest,
} from "./amazonFees.service";

interface CommissionRatesBody {
  items: CommissionRateRequest[];
  tenant_id?: string;
}

/**
 * Register internal Amazon fees routes
 * These routes are for server-to-server communication only
 */
export async function registerAmazonFeesRoutes(
  fastify: FastifyInstance
): Promise<void> {
  /**
   * POST /api/internal/amazon/commission-rates
   * Get commission rates for a batch of items
   *
   * Auth: Bearer token (KEYBUZZ_INTERNAL_TOKEN)
   * Body: { items: [{ sku, ean?, country, price? }], tenant_id?: string }
   * Response: { items: [...], errors: [...] }
   */
  fastify.post(
    "/api/internal/amazon/commission-rates",
    async (
      request: FastifyRequest<{ Body: CommissionRatesBody }>,
      reply: FastifyReply
    ) => {
      // 1. Validate Authorization header
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Missing or invalid Authorization header",
        });
      }

      const token = authHeader.substring(7); // Remove "Bearer "
      if (!validateInternalToken(token)) {
        // Don't log the token for security
        console.warn("[AmazonFees] Invalid internal token attempt");
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid token",
        });
      }

      // 2. Validate request body
      const { items, tenant_id } = request.body || {};

      if (!items || !Array.isArray(items)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Missing or invalid 'items' array",
        });
      }

      if (items.length === 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Items array cannot be empty",
        });
      }

      if (items.length > 100) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Maximum 100 items per request",
        });
      }

      // Validate each item
      const validationErrors: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.sku) {
          validationErrors.push(`Item ${i}: missing 'sku'`);
        }
        if (!item.country) {
          validationErrors.push(`Item ${i}: missing 'country'`);
        }
      }

      if (validationErrors.length > 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid items in request",
          details: validationErrors,
        });
      }

      // 3. Get tenant ID (from body or default)
      const tenantId = tenant_id || "ecomlg-001"; // Default tenant for ecomlg-sync

      console.log(
        `[AmazonFees] Processing ${items.length} items for tenant ${tenantId}`
      );

      try {
        // 4. Get commission rates
        const results = await getCommissionRates(tenantId, items);

        // 5. Separate successful results and errors
        const successItems = results.filter((r) => r.source !== "error");
        const errorItems = results.filter((r) => r.source === "error");

        // 6. Return response
        return reply.status(200).send({
          items: successItems,
          errors: errorItems.length > 0 ? errorItems : undefined,
          meta: {
            total_requested: items.length,
            total_success: successItems.length,
            total_errors: errorItems.length,
            tenant_id: tenantId,
          },
        });
      } catch (error) {
        console.error("[AmazonFees] Internal error:", error);
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to process commission rates",
        });
      }
    }
  );

  /**
   * GET /api/internal/amazon/commission-rates/health
   * Health check endpoint (no auth required for basic check)
   */
  fastify.get(
    "/api/internal/amazon/commission-rates/health",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const hasToken = !!process.env.KEYBUZZ_INTERNAL_TOKEN;
      return reply.status(200).send({
        status: "ok",
        service: "amazon-commission-rates",
        configured: hasToken,
        timestamp: new Date().toISOString(),
      });
    }
  );
}
