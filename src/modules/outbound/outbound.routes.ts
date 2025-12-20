/**
 * Outbound Email Routes
 * PH11-06B.3
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { PrismaClient, OutboundEmailStatus } from "@prisma/client";
import { sendEmail, getOutboundEmail, listOutboundEmails, retryEmail } from "./outboundEmail.service";

const prisma = new PrismaClient();

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

export async function registerOutboundRoutes(server: FastifyInstance) {
  // All routes require auth
  server.addHook("preHandler", authenticate);

  /**
   * POST /api/v1/outbound/send
   * Send an outbound email
   */
  server.post("/api/v1/outbound/send", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const body = request.body as {
      ticketId: string;
      to: string;
      subject: string;
      body: string;
      from?: string;
    };

    if (!body.ticketId || !body.to || !body.subject || !body.body) {
      return reply.status(400).send({ error: "Missing required fields" });
    }

    const result = await sendEmail({
      tenantId: user.tenantId,
      ticketId: body.ticketId,
      toAddress: body.to,
      subject: body.subject,
      body: body.body,
      from: body.from,
    });

    if (result.status === OutboundEmailStatus.SENT) {
      return reply.send({
        success: true,
        id: result.id,
        status: result.status,
      });
    } else {
      return reply.status(500).send({
        success: false,
        id: result.id,
        status: result.status,
        error: result.error,
      });
    }
  });

  /**
   * GET /api/v1/outbound/emails/:id
   * Get outbound email by ID
   */
  server.get("/api/v1/outbound/emails/:id", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    const { id } = request.params as { id: string };

    const email = await getOutboundEmail(id);
    
    if (!email) {
      return reply.status(404).send({ error: "Not found" });
    }

    if (user?.role !== "super_admin" && email.tenantId !== user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    return reply.send({ email });
  });

  /**
   * GET /api/v1/outbound/tickets/:ticketId/emails
   * List outbound emails for ticket
   */
  server.get("/api/v1/outbound/tickets/:ticketId/emails", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    const { ticketId } = request.params as { ticketId: string };

    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const emails = await listOutboundEmails(ticketId);
    
    return reply.send({ emails });
  });

  /**
   * POST /api/v1/outbound/emails/:id/retry
   * Retry failed email
   */
  server.post("/api/v1/outbound/emails/:id/retry", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    const { id } = request.params as { id: string };

    const email = await getOutboundEmail(id);
    
    if (!email) {
      return reply.status(404).send({ error: "Not found" });
    }

    if (user?.role !== "super_admin" && email.tenantId !== user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const result = await retryEmail(id);
    
    if (result.success) {
      return reply.send({ success: true, message: "Email resent" });
    } else {
      return reply.status(500).send({ success: false, error: result.error });
    }
  });

  /**
   * GET /api/v1/outbound/recent
   * Get recent outbound emails for tenant
   */
  server.get("/api/v1/outbound/recent", async (request, reply) => {
    const user = request.user as JwtUserPayload;

    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const emails = await prisma.outboundEmail.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return reply.send({ emails });
  });
}
