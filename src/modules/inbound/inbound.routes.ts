/* eslint-disable @typescript-eslint/no-explicit-any */
// src/modules/inbound/inbound.routes.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/db";
import { MarketplaceType } from "@prisma/client";
import { parseInboundAddress, processValidationEmail } from "./inbound.service";

export async function registerInboundRoutes(server: FastifyInstance) {
  /**
   * POST /api/v1/inbound/email
   * Receive inbound emails from mail server webhook
   */
  server.post("/api/v1/inbound/email", async (request, reply) => {
    try {
    // PH11-06B.5F: Webhook auth
    const internalKey = String(request.headers["x-internal-key"] ?? "");
    const expectedKey = process.env.INBOUND_WEBHOOK_KEY ?? "";
    if (!expectedKey || internalKey !== expectedKey) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

      const payload = request.body as {
        from: string;
        to: string;
        subject?: string;
        messageId: string;
        receivedAt: string;
        body: string;
      };

      console.log("[Inbound Email] Received:", {
        from: payload.from,
        to: payload.to,
        messageId: payload.messageId,
      });

      // PH11-06B.5A: Check if this is a validation email
      const validationResult = await processValidationEmail({
        to: payload.to,
        subject: payload.subject || '',
        from: payload.from,
        messageId: payload.messageId,
      });

      if (validationResult.validated) {
        console.log(`[Validation] Email processed as validation: ${payload.messageId}`);
        return reply.send({
          success: true,
          validation: true,
          addressId: validationResult.addressId,
          messageId: payload.messageId,
        });
      }

      // Parse recipient avec nouveau format ou legacy
      const parsed = parseInboundAddress(payload.to);
      if (!parsed.marketplace || !parsed.tenantId) {
        return reply.status(400).send({ error: "Invalid recipient format" });
      }

      const { marketplace, tenantId } = parsed;

      if (marketplace.toLowerCase() !== "amazon") {
        return reply.status(400).send({ error: "Unsupported marketplace" });
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
        console.log("[Inbound Email] Already processed:", payload.messageId);
        return reply.send({ success: true, message: "Already processed" });
      }

      // Create ExternalMessage
      const externalMessage = await prisma.externalMessage.create({
        data: {
          tenantId,
          connectionId: tenantId,
          type: MarketplaceType.AMAZON,
          externalId: payload.messageId,
          buyerEmail: payload.from,
          buyerName: payload.from.split("@")[0] || "Unknown",
          receivedAt: new Date(payload.receivedAt),
          raw: payload as any,
        },
      });

      // Find or create Ticket
      let ticket = await prisma.ticket.findFirst({
        where: { tenantId, externalId: payload.messageId },
      });

      if (!ticket) {
        ticket = await prisma.ticket.create({
          data: {
            tenantId,
            channel: "AMAZON",
            status: "OPEN",
            subject: payload.subject || "New Amazon Message",
            customerName: externalMessage.buyerName || "Amazon Buyer",
            customerEmail: externalMessage.buyerEmail,
            externalId: payload.messageId,
            priority: "NORMAL",
          },
        });
      }

      // Create TicketMessage
      await prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          tenantId,
          senderType: "CUSTOMER",
          source: "MARKETPLACE",
          body: payload.body,
        },
      });

      // Create TicketEvent
      await prisma.ticketEvent.create({
        data: {
          ticketId: ticket.id,
          tenantId,
          type: "MESSAGE_RECEIVED",
          actorType: "SYSTEM",
          payload: {
            source: "email_inbound",
            messageId: payload.messageId,
          } as any,
        },
      });

      // Link ExternalMessage to Ticket
      await prisma.externalMessage.update({
        where: { id: externalMessage.id },
        data: { ticketId: ticket.id },
      });

      return reply.send({
        success: true,
        messageId: payload.messageId,
        ticketId: ticket.id,
      });
    } catch (error) {
      console.error("[Inbound Email] Error:", error);
      return reply.status(500).send({
        error: "Failed to process email",
        details: (error as Error).message,
      });
    }
  });
}
