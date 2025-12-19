// PH11-06B.5F + PH11-06B.6.2: Dedicated inbound email webhook with Amazon detection
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { prisma } from "../../lib/db";
import { MarketplaceType } from "@prisma/client";
import { parseInboundAddress, processValidationEmail, updateMarketplaceStatusIfAmazon } from "../inbound/inbound.service";

async function inboundEmailWebhookPlugin(server: FastifyInstance, _opts: FastifyPluginOptions) {
  /**
   * POST /inbound-email
   * Dedicated webhook endpoint for Postfix (no JWT, internal key auth only)
   */
  server.post("/inbound-email", async (request, reply) => {
    // Internal key authentication
    const internalKey = String(request.headers["x-internal-key"] ?? "");
    const expectedKey = process.env.INBOUND_WEBHOOK_KEY ?? "";
    
    if (!expectedKey) {
      console.error("[Webhook] INBOUND_WEBHOOK_KEY not configured");
      return reply.code(500).send({ error: "Server configuration error" });
    }
    
    if (!internalKey || internalKey !== expectedKey) {
      console.warn("[Webhook] Unauthorized attempt:", { 
        hasKey: !!internalKey,
        keyMatch: false 
      });
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const payload = request.body as {
        from: string;
        to: string;
        subject?: string;
        messageId: string;
        receivedAt: string;
        body: string;
        headers?: Record<string, string>;
      };

      console.log("[Webhook] Received inbound email:", {
        from: payload.from,
        to: payload.to,
        messageId: payload.messageId,
      });

      // Parse recipient first
      const parsed = parseInboundAddress(payload.to);
      if (!parsed.marketplace || !parsed.tenantId) {
        console.warn("[Webhook] Invalid recipient format:", payload.to);
        return reply.code(400).send({ error: "Invalid recipient format" });
      }

      const { marketplace, tenantId } = parsed;
      const country = (parsed.country || 'FR').toUpperCase();

      if (marketplace.toLowerCase() !== "amazon") {
        return reply.code(400).send({ error: "Unsupported marketplace" });
      }

      // Check if validation email
      const validationResult = await processValidationEmail({
        to: payload.to,
        subject: payload.subject || "",
        from: payload.from,
        messageId: payload.messageId,
        headers: payload.headers || {},
        rawEmail: payload.body || "",
      });

      if (validationResult.validated) {
        console.log(`[Webhook] Validation email processed: ${payload.messageId}`);
        return reply.send({
          success: true,
          validation: true,
          addressId: validationResult.addressId,
          messageId: payload.messageId,
        });
      }

      // For non-validation emails, check if it's an Amazon forward
      // PH11-06B.6.2: Update marketplaceStatus if Amazon email detected
      const amazonUpdated = await updateMarketplaceStatusIfAmazon({
        tenantId,
        marketplace,
        country,
        from: payload.from,
        messageId: payload.messageId,
        headers: payload.headers || {},
        rawEmail: payload.body || "",
      });

      if (amazonUpdated) {
        console.log(`[Webhook] Amazon forward detected, marketplaceStatus updated for ${tenantId}/${country}`);
      }

      // Idempotence check
      const existing = await prisma.externalMessage.findUnique({
        where: {
          type_connectionId_externalId: {
            type: MarketplaceType.AMAZON,
            connectionId: tenantId,
            externalId: payload.messageId,
          },
        },
      });

      if (existing) {
        console.log("[Webhook] Already processed:", payload.messageId);
        return reply.send({ success: true, message: "Already processed", amazonForward: amazonUpdated });
      }

      // Create ExternalMessage
      const externalMessage = await prisma.externalMessage.create({
        data: {
          tenantId,
          connectionId: tenantId,
          type: MarketplaceType.AMAZON,
          externalId: payload.messageId,
          buyerEmail: payload.from,
          receivedAt: new Date(payload.receivedAt),
          raw: {
            from: payload.from,
            to: payload.to,
            subject: payload.subject || "",
            body: payload.body,
            messageId: payload.messageId,
          },
        },
      });

      console.log("[Webhook] ExternalMessage created:", externalMessage.id);

      // Update InboundAddress lastInboundAt
      await prisma.inboundAddress.updateMany({
        where: {
          tenantId,
          marketplace: MarketplaceType.AMAZON,
          country,
        },
        data: {
          lastInboundAt: new Date(),
          lastInboundMessageId: payload.messageId,
        },
      });

      return reply.send({
        success: true,
        messageId: externalMessage.id,
        externalId: payload.messageId,
        amazonForward: amazonUpdated,
      });

    } catch (error) {
      console.error("[Webhook] Error processing inbound email:", error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });
}

// Export as regular function to be registered with prefix
export async function registerInboundEmailWebhookRoutes(server: FastifyInstance) {
  await server.register(inboundEmailWebhookPlugin, { prefix: '/api/v1/webhooks' });
}
