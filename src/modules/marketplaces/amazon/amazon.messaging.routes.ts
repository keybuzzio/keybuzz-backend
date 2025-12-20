// src/modules/marketplaces/amazon/amazon.messaging.routes.ts
// PH11-06B.9 - Amazon Messaging API endpoints

import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from "fastify";
import { prisma } from "../../../lib/db";
import { enqueueJob } from "../../jobs/jobs.service";
import { checkMessagingCapabilities } from "./amazon.spapi";

const BLOCKED_KEYWORDS = [
  "refund", "lawsuit", "attorney", "lawyer", "legal action",
  "sue you", "police", "fraud", "scam",
];

interface JwtUserPayload {
  sub?: string;
  tenantId?: string;
  role?: string;
}

async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}

function containsBlockedKeyword(message: string): string | null {
  const lower = message.toLowerCase();
  for (const kw of BLOCKED_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

async function amazonMessagingPlugin(server: FastifyInstance, _opts: FastifyPluginOptions) {
  server.addHook("preHandler", authenticate);

  /**
   * POST /tickets/:ticketId/send-reply
   */
  server.post("/tickets/:ticketId/send-reply", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
    }

    const { ticketId } = request.params as { ticketId: string };
    const { message } = request.body as { message: string };

    if (!message || typeof message !== "string") {
      return reply.status(400).send({ error: "Message is required" });
    }

    if (message.length > 2000) {
      return reply.status(400).send({ error: "Message too long (max 2000 chars)" });
    }

    const blocked = containsBlockedKeyword(message);
    if (blocked) {
      return reply.status(409).send({ error: "Message contains blocked content", keyword: blocked });
    }

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, tenantId: user.tenantId },
    });

    if (!ticket) {
      return reply.status(404).send({ error: "Ticket not found" });
    }

    if (ticket.status === "RESOLVED" || ticket.status === "ESCALATED") {
      return reply.status(409).send({ error: "Cannot reply to " + ticket.status + " ticket" });
    }

    // Check Amazon capabilities (allow bypass in dev mode)
    const isDevMode = process.env.KEYBUZZ_DEV_MODE === "true";
    const caps = await checkMessagingCapabilities(user.tenantId);
    
    if (!caps.canSend && !isDevMode) {
      return reply.status(409).send({ error: "Amazon OAuth not connected", code: caps.reason });
    }

    // Enqueue job
    const jobId = await enqueueJob({
      type: "AMAZON_SEND_REPLY",
      tenantId: user.tenantId,
      payload: { ticketId, message, amazonOrderId: ticket.externalId },
    });

    console.log("[AmazonMessaging] Enqueued send-reply job " + jobId + " for ticket " + ticketId);

    return reply.status(202).send({ 
      success: true, 
      jobId, 
      message: "Reply queued for delivery",
      devMode: isDevMode,
    });
  });

  /**
   * GET /tickets/:ticketId/outbound
   */
  server.get("/tickets/:ticketId/outbound", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
    }

    const { ticketId } = request.params as { ticketId: string };

    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, tenantId: user.tenantId },
    });

    if (!ticket) {
      return reply.status(404).send({ error: "Ticket not found" });
    }

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

  /**
   * GET /capabilities
   */
  server.get("/capabilities", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
    }

    const caps = await checkMessagingCapabilities(user.tenantId);
    return reply.send(caps);
  });
}

export async function registerAmazonMessagingRoutes(server: FastifyInstance) {
  await server.register(amazonMessagingPlugin, { prefix: "/api/v1/marketplaces/amazon" });
}
