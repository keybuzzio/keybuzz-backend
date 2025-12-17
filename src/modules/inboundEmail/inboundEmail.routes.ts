/**
 * API Endpoints Inbound Email Management
 * PH11-06B.5A
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../../lib/db";
import { ensureInboundConnection } from "./inboundEmailAddress.service";
import { sendValidationEmail, regenerateToken } from "./inboundEmailValidation.service";

// Extend FastifyRequest to include user
declare module "fastify" {
  interface FastifyRequest {
    user?: {
      userId: string;
      email: string;
      tenantId?: string;
      role: string;
    };
  }
}

/**
 * JWT Authentication preHandler
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.status(401).send({ error: "Unauthorized", details: (err as Error).message });
  }
}

export async function registerInboundEmailRoutes(server: FastifyInstance) {
  // Apply JWT authentication to all routes
  server.addHook("preHandler", authenticate);

  /**
   * GET /api/v1/inbound-email/connections
   * List all inbound connections for tenant
   */
  server.get("/api/v1/inbound-email/connections", async (request, reply) => {
    try {
      const tenantId = request.user?.tenantId;
      if (!tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      const connections = await prisma.inboundConnection.findMany({
        where: { tenantId },
        include: {
          addresses: true,
          tenant: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      // Calculate summary for UI
      const connectionsWithSummary = connections.map((conn) => ({
        ...conn,
        inboundAddressesCount: conn.addresses.length,
        validatedCount: conn.addresses.filter((a) => a.validationStatus === "VALIDATED").length,
        pendingCount: conn.addresses.filter((a) => a.validationStatus === "PENDING").length,
        failedCount: conn.addresses.filter((a) => a.validationStatus === "FAILED").length,
      }));

      return reply.send({ connections: connectionsWithSummary });
    } catch (error) {
      console.error("[InboundEmail] Error listing connections:", error);
      return reply.status(500).send({ error: "Failed to list connections" });
    }
  });

  /**
   * GET /api/v1/inbound-email/connections/:id
   * Get connection detail with addresses
   */
  server.get("/api/v1/inbound-email/connections/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const tenantId = request.user?.tenantId;
      if (!tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      const connection = await prisma.inboundConnection.findUnique({
        where: { id, tenantId },
        include: {
          addresses: true,
          tenant: { select: { name: true } },
        },
      });

      if (!connection) {
        return reply.status(404).send({ error: "Connection not found" });
      }

      // Calculate summary
      const connectionWithSummary = {
        ...connection,
        inboundAddressesCount: connection.addresses.length,
        validatedCount: connection.addresses.filter((a) => a.validationStatus === "VALIDATED").length,
        pendingCount: connection.addresses.filter((a) => a.validationStatus === "PENDING").length,
        failedCount: connection.addresses.filter((a) => a.validationStatus === "FAILED").length,
      };

      return reply.send(connectionWithSummary);
    } catch (error) {
      console.error("[InboundEmail] Error getting connection:", error);
      return reply.status(500).send({ error: "Failed to get connection" });
    }
  });

  /**
   * POST /api/v1/inbound-email/connections
   * Create or update inbound connection
   */
  server.post("/api/v1/inbound-email/connections", async (request, reply) => {
    try {
      const tenantId = request.user?.tenantId;
      if (!tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      const { marketplace, countries } = request.body as { marketplace: string; countries: string[] };

      if (!marketplace || !Array.isArray(countries) || countries.length === 0) {
        return reply.status(400).send({ error: "Invalid marketplace or countries" });
      }

      const connection = await ensureInboundConnection(tenantId, marketplace as any, countries);

      return reply.send(connection);
    } catch (error) {
      console.error("[InboundEmail] Error creating connection:", error);
      return reply.status(500).send({ error: "Failed to create connection" });
    }
  });

  /**
   * POST /api/v1/inbound-email/connections/:id/validate
   * Send validation email for country
   */
  server.post("/api/v1/inbound-email/connections/:id/validate", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { country } = request.body as { country: string };
      const tenantId = request.user?.tenantId;

      if (!tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      if (!country) {
        return reply.status(400).send({ error: "Missing country" });
      }

      // Verify connection belongs to tenant
      const connection = await prisma.inboundConnection.findUnique({
        where: { id, tenantId },
      });

      if (!connection) {
        return reply.status(404).send({ error: "Connection not found" });
      }

      await sendValidationEmail(id, country);

      return reply.status(202).send({ success: true, message: `Validation email enqueued for ${country}` });
    } catch (error) {
      console.error("[InboundEmail] Error sending validation email:", error);
      return reply.status(500).send({ error: "Failed to send validation email", details: (error as Error).message });
    }
  });

  /**
   * POST /api/v1/inbound-email/addresses/:id/regenerate
   * Regenerate token for address
   */
  server.post("/api/v1/inbound-email/addresses/:id/regenerate", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const tenantId = request.user?.tenantId;

      if (!tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      // Verify address belongs to tenant
      const address = await prisma.inboundAddress.findUnique({
        where: { id, tenantId },
      });

      if (!address) {
        return reply.status(404).send({ error: "Address not found" });
      }

      const result = await regenerateToken(id);

      return reply.send({ success: true, newEmailAddress: result.newEmailAddress });
    } catch (error) {
      console.error("[InboundEmail] Error regenerating token:", error);
      return reply.status(500).send({ error: "Failed to regenerate token", details: (error as Error).message });
    }
  });

  /**
   * GET /api/v1/inbound-email/health
   * Get health indicators (mock for now)
   */
  server.get("/api/v1/inbound-email/health", async (request, reply) => {
    // Mock health indicators
    const indicators = [
      { name: "DKIM Inbound", status: "OK", message: "DKIM signature valid", lastCheckedAt: new Date().toISOString() },
      { name: "DMARC", status: "OK", message: "DMARC policy pass", lastCheckedAt: new Date().toISOString() },
      { name: "MTA-STS", status: "OK", message: "TLS connection established", lastCheckedAt: new Date().toISOString() },
      { name: "Webhook", status: "OK", message: "Postfix webhook responding", lastCheckedAt: new Date().toISOString() },
      { name: "Backend", status: "OK", message: "API responding", lastCheckedAt: new Date().toISOString() },
    ];

    return reply.send({ indicators });
  });
}
