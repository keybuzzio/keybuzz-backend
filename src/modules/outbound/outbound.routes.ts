/* eslint-disable @typescript-eslint/no-explicit-any */
// src/modules/outbound/outbound.routes.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/db";
import {
  sendEmail,
  getRecentOutboundEmails,
  getRecentTenantOutboundEmails,
} from "./outboundEmail.service";

// Rate limits
const RATE_LIMIT_PER_TICKET_HOURLY = 5;
const RATE_LIMIT_PER_TENANT_HOURLY = 50;

export async function registerOutboundRoutes(server: FastifyInstance) {
  /**
   * POST /internal/outbound/email
   * Internal endpoint to send outbound emails
   * ⚠️ Not exposed publicly - called from AI autosend or manual reply
   */
  server.post("/internal/outbound/email", async (request, reply) => {
    try {
      const payload = request.body as {
        tenantId: string;
        ticketId: string;
        to: string;
        subject: string;
        body: string;
        from?: string;
      };

      console.log("[Outbound Email] Request:", {
        tenantId: payload.tenantId,
        ticketId: payload.ticketId,
        to: payload.to,
      });

      // Validation: Required fields
      if (!payload.tenantId || !payload.ticketId || !payload.to || !payload.subject || !payload.body) {
        return reply.status(400).send({ error: "Missing required fields" });
      }

      // Validation: Email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(payload.to)) {
        return reply.status(400).send({ error: "Invalid email format" });
      }

      // Guard 1: Check ticket exists and is not closed/escalated
      const ticket = await prisma.ticket.findUnique({
        where: { id: payload.ticketId },
        select: { status: true, tenantId: true },
      });

      if (!ticket) {
        return reply.status(404).send({ error: "Ticket not found" });
      }

      if (ticket.tenantId !== payload.tenantId) {
        return reply.status(403).send({ error: "Tenant mismatch" });
      }

      if (ticket.status === "CLOSED" || ticket.status === "ESCALATED") {
        return reply.status(400).send({
          error: `Cannot send email: ticket is ${ticket.status}`,
        });
      }

      // Guard 2: Rate limit per ticket (5/hour)
      const ticketEmailCount = await getRecentOutboundEmails(payload.ticketId, 1);
      if (ticketEmailCount >= RATE_LIMIT_PER_TICKET_HOURLY) {
        console.warn(
          `[Outbound Email] Rate limit exceeded for ticket ${payload.ticketId}: ${ticketEmailCount}/hour`
        );
        return reply.status(429).send({
          error: "Rate limit exceeded for this ticket",
          limit: RATE_LIMIT_PER_TICKET_HOURLY,
          retryAfter: 3600,
        });
      }

      // Guard 3: Rate limit per tenant (50/hour)
      const tenantEmailCount = await getRecentTenantOutboundEmails(payload.tenantId, 1);
      if (tenantEmailCount >= RATE_LIMIT_PER_TENANT_HOURLY) {
        console.warn(
          `[Outbound Email] Rate limit exceeded for tenant ${payload.tenantId}: ${tenantEmailCount}/hour`
        );
        return reply.status(429).send({
          error: "Rate limit exceeded for tenant",
          limit: RATE_LIMIT_PER_TENANT_HOURLY,
          retryAfter: 3600,
        });
      }

      // Guard 4: Blocage mots sensibles (optionnel, déjà géré par AI Safety Gate)
      const sensitiveWords = ["password", "credit card", "ssn"];
      const bodyLower = payload.body.toLowerCase();
      const hasSensitiveWords = sensitiveWords.some((word) => bodyLower.includes(word));

      if (hasSensitiveWords) {
        console.warn(`[Outbound Email] Sensitive words detected in email body`);
        return reply.status(400).send({
          error: "Email contains sensitive information",
        });
      }

      // Send email (SMTP → SES fallback)
      const result = await sendEmail(payload);

      if (result.success) {
        // Create TicketMessage for sent email
        const ticketMessage = await prisma.ticketMessage.create({
          data: {
            ticketId: payload.ticketId,
            tenantId: payload.tenantId,
            senderType: "AI", // or "HUMAN" depending on context
            body: payload.body,
            source: "EMAIL",
            // metadata can store outboundEmailId
          },
        });

        // Log TicketEvent
        await prisma.ticketEvent.create({
          data: {
            ticketId: payload.ticketId,
            tenantId: payload.tenantId,
            type: "OUTBOUND_EMAIL_SENT" as any,
            actorType: "SYSTEM",
            // metadata: { outboundEmailId: result.outboundEmailId, provider: result.provider }
          },
        });

        console.log(
          `[Outbound Email] ✓ Sent via ${result.provider} (ID: ${result.outboundEmailId})`
        );

        return reply.send({
          success: true,
          provider: result.provider,
          outboundEmailId: result.outboundEmailId,
          ticketMessageId: ticketMessage.id,
        });
      } else {
        // Log TicketEvent for failure
        await prisma.ticketEvent.create({
          data: {
            ticketId: payload.ticketId,
            tenantId: payload.tenantId,
            type: "OUTBOUND_EMAIL_FAILED" as any,
            actorType: "SYSTEM",
            // metadata: { error: result.error }
          },
        });

        console.error(
          `[Outbound Email] ✗ Failed (ID: ${result.outboundEmailId}): ${result.error}`
        );

        return reply.status(500).send({
          success: false,
          error: result.error,
          outboundEmailId: result.outboundEmailId,
        });
      }
    } catch (error: any) {
      console.error("[Outbound Email] Unexpected error:", error);
      return reply.status(500).send({
        error: "Internal server error",
        message: error.message,
      });
    }
  });

  /**
   * GET /internal/outbound/email/:ticketId/history
   * Get outbound email history for a ticket (internal use)
   */
  server.get("/internal/outbound/email/:ticketId/history", async (request, reply) => {
    try {
      const { ticketId } = request.params as { ticketId: string };

      const emails = await prisma.outboundEmail.findMany({
        where: { ticketId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          to: true,
          subject: true,
          provider: true,
          status: true,
          sentAt: true,
          createdAt: true,
          error: true,
        },
      });

      return reply.send({ emails });
    } catch (error: any) {
      console.error("[Outbound Email] Error fetching history:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}

