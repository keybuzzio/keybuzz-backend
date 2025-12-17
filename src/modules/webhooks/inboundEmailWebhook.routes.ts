// PH11-06B.5F.1: Dedicated inbound email webhook (no JWT)
import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/db";
import { MarketplaceType } from "@prisma/client";
import { parseInboundAddress, processValidationEmail } from "../inbound/inbound.service";

export async function registerInboundEmailWebhookRoutes(server: FastifyInstance) {
  /**
   * POST /api/v1/webhooks/inbound-email
   * Dedicated webhook endpoint for Postfix (no JWT, internal key auth only)
   */
  server.post("/api/v1/webhooks/inbound-email", async (request, reply) => {
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
      };

      console.log("[Webhook] Received inbound email:", {
        from: payload.from,
        to: payload.to,
        messageId: payload.messageId,
      });

      // Check if validation email
      const validationResult = await processValidationEmail({
        to: payload.to,
        subject: payload.subject || '',
        from: payload.from,
        messageId: payload.messageId,
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

      // Parse recipient
      const parsed = parseInboundAddress(payload.to);
      if (!parsed.marketplace || !parsed.tenantId) {
        console.warn("[Webhook] Invalid recipient format:", payload.to);
        return reply.code(400).send({ error: "Invalid recipient format" });
      }

      const { marketplace, tenantId } = parsed;

      if (marketplace.toLowerCase() !== "amazon") {
        return reply.code(400).send({ error: "Unsupported marketplace" });
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
        return reply.send({ success: true, message: "Already processed" });
      }

      // Create ExternalMessage
      const externalMessage = await prisma.externalMessage.create({
        data: {
          tenantId,
          connectionId: tenantId,
          type: MarketplaceType.AMAZON,
          externalId: payload.messageId,
          subject: payload.subject || "",
          rawContent: payload.body,
          senderEmail: payload.from,
          receivedAt: new Date(payload.receivedAt),
        },
      });

      console.log("[Webhook] ExternalMessage created:", externalMessage.id);

      // Update InboundAddress lastInboundAt if exists
      const country = parsed.country || 'FR'; // fallback
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
      });

    } catch (error) {
      console.error("[Webhook] Error processing inbound email:", error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });
}
