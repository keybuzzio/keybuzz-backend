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
    // PH11-06B.5F: Validate internal webhook key
    const internalKey = request.headers['x-internal-key'] as string;
    const expectedKey = process.env.INBOUND_WEBHOOK_KEY;
    
    if (!expectedKey) {
      console.warn('[InboundEmail] INBOUND_WEBHOOK_KEY not configured');
    } else if (!internalKey || internalKey !== expectedKey) {
      console.warn('[InboundEmail] Unauthorized webhook attempt');
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Handle raw email (message/rfc822) content type
    let payload: {
      from: string;
      to: string;
      subject?: string;
      messageId: string;
      receivedAt: string;
      body: string;
    };

    const contentType = request.headers['content-type'] || '';
    
    if (contentType.includes('message/rfc822') || typeof request.body === 'string') {
      // Parse raw email
      const rawEmail = typeof request.body === 'string' ? request.body : String(request.body);
      const lines = rawEmail.split('\n');
      
      let from = '';
      let to = '';
      let subject = '';
      let messageId = `inbound-${Date.now()}`;
      let bodyStartIndex = 0;
      
      // Parse headers
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
          bodyStartIndex = i + 1;
          break;
        }
        
        if (line.match(/^From:/i)) {
          from = line.replace(/^From:\s*/i, '').trim();
        } else if (line.match(/^To:/i)) {
          to = line.replace(/^To:\s*/i, '').trim();
        } else if (line.match(/^Subject:/i)) {
          subject = line.replace(/^Subject:\s*/i, '').trim();
        } else if (line.match(/^Message-ID:/i)) {
          messageId = line.replace(/^Message-ID:\s*/i, '').trim().replace(/[<>]/g, '');
        }
      }
      
      const body = lines.slice(bodyStartIndex).join('\n');
      
      payload = {
        from,
        to,
        subject,
        messageId,
        receivedAt: new Date().toISOString(),
        body,
      };
      
      console.log('[InboundEmail] Parsed raw email:', { from, to, subject, messageId });
    } else {
      // JSON payload (existing behavior)
      payload = request.body as any;
    }

    try {
  server.post("/api/v1/inbound/email", async (request, reply) => {
    try {
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
