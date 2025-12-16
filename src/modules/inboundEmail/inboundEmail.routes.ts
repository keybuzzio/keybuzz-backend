/**
 * API Endpoints Inbound Email Management
 * PH11-06B.5A
 */

import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/db";
import { ensureInboundConnection } from "./inboundEmailAddress.service";
import { sendValidationEmail, regenerateToken } from "./inboundEmailValidation.service";

export async function registerInboundEmailRoutes(server: FastifyInstance) {
  /**
   * GET /api/v1/inbound-email/connections
   * List all inbound connections for tenant
   */
  server.get("/api/v1/inbound-email/connections", async (request, reply) => {
    try {
      const tenantId = (request as any).user?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const connections = await prisma.inboundConnection.findMany({
        where: { tenantId },
        include: {
          addresses: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({ connections });
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
      const tenantId = (request as any).user?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const connection = await prisma.inboundConnection.findUnique({
        where: { id },
        include: {
          addresses: true,
        },
      });

      if (!connection || connection.tenantId !== tenantId) {
        return reply.status(404).send({ error: "Connection not found" });
      }

      return reply.send({ connection });
    } catch (error) {
      console.error("[InboundEmail] Error getting connection:", error);
      return reply.status(500).send({ error: "Failed to get connection" });
    }
  });

  /**
   * POST /api/v1/inbound-email/connections
   * Create/update inbound connection
   */
  server.post("/api/v1/inbound-email/connections", async (request, reply) => {
    try {
      const tenantId = (request as any).user?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const payload = request.body as {
        marketplace: string;
        countries: string[];
      };

      if (!payload.marketplace || !payload.countries || payload.countries.length === 0) {
        return reply.status(400).send({ error: "Missing marketplace or countries" });
      }

      const connection = await ensureInboundConnection({
        tenantId,
        marketplace: payload.marketplace,
        countries: payload.countries,
      });

      return reply.send({ connection });
    } catch (error) {
      console.error("[InboundEmail] Error creating connection:", error);
      return reply.status(500).send({ error: "Failed to create connection" });
    }
  });

  /**
   * POST /api/v1/inbound-email/connections/:id/validate
   * Send validation email
   */
  server.post("/api/v1/inbound-email/connections/:id/validate", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const tenantId = (request as any).user?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const payload = request.body as { country?: string };

      const connection = await prisma.inboundConnection.findUnique({
        where: { id },
      });

      if (!connection || connection.tenantId !== tenantId) {
        return reply.status(404).send({ error: "Connection not found" });
      }

      const result = await sendValidationEmail(id, payload.country);

      return reply.send(result);
    } catch (error) {
      console.error("[InboundEmail] Error sending validation:", error);
      return reply.status(500).send({ error: "Failed to send validation email" });
    }
  });

  /**
   * POST /api/v1/inbound-email/addresses/:id/regenerate
   * Regenerate token for address
   */
  server.post("/api/v1/inbound-email/addresses/:id/regenerate", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const tenantId = (request as any).user?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // Verify ownership
      const address = await prisma.inboundAddress.findUnique({
        where: { id },
      });

      if (!address || address.tenantId !== tenantId) {
        return reply.status(404).send({ error: "Address not found" });
      }

      const updated = await regenerateToken(id);

      return reply.send({ address: updated });
    } catch (error) {
      console.error("[InboundEmail] Error regenerating token:", error);
      return reply.status(500).send({ error: "Failed to regenerate token" });
    }
  });

  /**
   * GET /api/v1/inbound-email/health
   * Health indicators (mock pour l'instant)
   */
  server.get("/api/v1/inbound-email/health", async (request, reply) => {
    try {
      const tenantId = (request as any).user?.tenantId;
      if (!tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // TODO: Implement real health checks (DKIM, DMARC, MTA-STS, etc.)
      const indicators = [
        { name: "DKIM Inbound", status: "OK", message: "DKIM signature valid", lastCheckedAt: new Date().toISOString() },
        { name: "DMARC", status: "OK", message: "DMARC policy pass", lastCheckedAt: new Date().toISOString() },
        { name: "MTA-STS", status: "OK", message: "TLS connection established", lastCheckedAt: new Date().toISOString() },
        { name: "Webhook", status: "OK", message: "Postfix webhook responding", lastCheckedAt: new Date().toISOString() },
        { name: "Backend", status: "OK", message: "API /inbound/email responding", lastCheckedAt: new Date().toISOString() },
      ];

      return reply.send({ indicators });
    } catch (error) {
      console.error("[InboundEmail] Error getting health:", error);
      return reply.status(500).send({ error: "Failed to get health indicators" });
    }
  });
}
