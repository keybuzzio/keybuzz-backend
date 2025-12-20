/**
 * PH11-06B.9: Amazon Reply API Routes
 * Manual send-reply with safety checks
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from "fastify";
import { PrismaClient, MarketplaceType, TicketChannel, JobType } from "@prisma/client";
import { enqueueJob } from "../../jobs/jobs.service";

const prisma = new PrismaClient();

// Sensitive keywords that should block sending
const BLOCKED_KEYWORDS = [
  "refund",
  "legal action",
  "lawsuit",
  "attorney",
  "lawyer",
  "court",
  "fraud",
  "scam",
  "police",
];

const MAX_MESSAGE_LENGTH = 2000;

interface JwtUserPayload {
  sub?: string;
  tenantId?: string;
  role?: string;
}

/**
 * JWT Authentication
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}

/**
 * Check for blocked keywords
 */
function containsBlockedKeywords(message: string): string | null {
  const lowerMessage = message.toLowerCase();
  for (const keyword of BLOCKED_KEYWORDS) {
    if (lowerMessage.includes(keyword.toLowerCase())) {
      return keyword;
    }
  }
  return null;
}

/**
 * Amazon Reply routes plugin
 */
async function amazonReplyPlugin(server: FastifyInstance, _opts: FastifyPluginOptions) {
  server.addHook("preHandler", authenticate);

  /**
   * POST /api/v1/marketplaces/amazon/tickets/:ticketId/send-reply
   * Enqueue a reply to be sent via Amazon
   */
  server.post("/tickets/:ticketId/send-reply", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    const { ticketId } = request.params as { ticketId: string };
    const body = request.body as { message: string };

    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
    }

    // Validate message
    if (!body?.message || typeof body.message !== "string") {
      return reply.status(400).send({ error: "Message is required" });
    }

    const message = body.message.trim();

    if (message.length === 0) {
      return reply.status(400).send({ error: "Message cannot be empty" });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return reply.status(400).send({ 
        error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` 
      });
    }

    // Check for blocked keywords
    const blockedKeyword = containsBlockedKeywords(message);
    if (blockedKeyword) {
      return reply.status(400).send({
        error: "Message contains blocked content",
        details: `Keyword "${blockedKeyword}" is not allowed`,
      });
    }

    // Get ticket
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return reply.status(404).send({ error: "Ticket not found" });
    }

    // Check tenant ownership (allow super_admin override)
    if (user.role !== "super_admin" && ticket.tenantId !== user.tenantId) {
      return reply.status(403).send({ error: "Forbidden: ticket belongs to another tenant" });
    }

    // Check ticket status
    if (ticket.status === "CLOSED" || ticket.status === "RESOLVED") {
      return reply.status(409).send({
        error: "Cannot reply to closed/resolved ticket",
        status: ticket.status,
      });
    }

    // Check channel
    if (ticket.channel !== TicketChannel.AMAZON) {
      return reply.status(409).send({
        error: "Ticket is not an Amazon ticket",
        channel: ticket.channel,
      });
    }

    // Get Amazon connection
    const connection = await prisma.marketplaceConnection.findFirst({
      where: {
        tenantId: ticket.tenantId,
        type: MarketplaceType.AMAZON,
        status: "CONNECTED",
      },
    });

    if (!connection) {
      return reply.status(409).send({
        error: "Amazon connection not found or not connected",
        code: "oauth_not_connected",
      });
    }

    // Get external message for thread context
    const externalMsg = await prisma.externalMessage.findFirst({
      where: { ticketId },
      orderBy: { receivedAt: "desc" },
    });

    // Enqueue job
    const jobId = await enqueueJob({
      type: JobType.AMAZON_SEND_REPLY,
      tenantId: ticket.tenantId,
      payload: {
        ticketId,
        connectionId: connection.id,
        message,
        externalThreadId: externalMsg?.threadId || null,
        orderId: externalMsg?.orderId || ticket.externalId || null,
        to: externalMsg?.buyerEmail || null,
      },
      maxAttempts: 3,
    });

    console.log(`[AmazonReply] Enqueued job ${jobId} for ticket ${ticketId}`);

    return reply.status(202).send({
      success: true,
      jobId,
      message: "Reply queued for sending",
      status: "PENDING",
    });
  });

  /**
   * GET /api/v1/marketplaces/amazon/tickets/:ticketId/outbound
   * Get outbound message history for ticket
   */
  server.get("/tickets/:ticketId/outbound", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    const { ticketId } = request.params as { ticketId: string };

    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
    }

    // Get ticket to verify ownership
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      return reply.status(404).send({ error: "Ticket not found" });
    }

    if (user.role !== "super_admin" && ticket.tenantId !== user.tenantId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Get outbound messages
    const messages = await prisma.marketplaceOutboundMessage.findMany({
      where: { ticketId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        body: true,
        providerMessageId: true,
        error: true,
        attempts: true,
        createdAt: true,
        sentAt: true,
      },
    });

    return reply.send({ messages });
  });
}

/**
 * Register Amazon reply routes
 */
export async function registerAmazonReplyRoutes(server: FastifyInstance) {
  await server.register(amazonReplyPlugin, { prefix: "/api/v1/marketplaces/amazon" });
}
