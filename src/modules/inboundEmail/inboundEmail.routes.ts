/**
 * API Endpoints Inbound Email Management
 * PH11-06B.5A
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getAllHealthChecks } from "../inbound/inboundHealth.service";
import { prisma } from "../../lib/db";
import { ensureInboundConnection } from "./inboundEmailAddress.service";
import { CreateConnectionSchema } from "./inboundEmail.validation";
import { sendValidationEmail, regenerateToken } from "./inboundEmailValidation.service";

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
      const user = request.user;
      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      const connections = await prisma.inboundConnection.findMany({
        where: { tenantId: user.tenantId },
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
      const user = request.user;
      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      const connection = await prisma.inboundConnection.findUnique({
        where: { id, tenantId: user.tenantId },
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
      // 1) Validate input
      const validationResult = CreateConnectionSchema.safeParse(request.body);
      
      if (!validationResult.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: validationResult.error.issues.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      
      const { marketplace, countries } = validationResult.data;
      let tenantId = validationResult.data.tenantId;
      
      // 2) Determine tenantId based on role
      const user = request.user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const userRole = user.role;
      const userTenantId = user.tenantId;
      
      if (userRole === "super_admin" || userRole === "SUPER_ADMIN") {
        // Super admin must provide tenantId in body
        if (!tenantId) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "tenantId is required for super_admin role",
          });
        }
        
        // Verify tenant exists
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
        });
        
        if (!tenant) {
          return reply.status(404).send({
            error: "Not Found",
            message: `Tenant ${tenantId} not found`,
          });
        }
      } else {
        // Other roles use their own tenantId
        if (!userTenantId) {
          return reply.status(403).send({
            error: "Forbidden",
            message: "No tenantId associated with your account",
          });
        }
        tenantId = userTenantId;
      }
      
      // 3) Create connection - tenantId is guaranteed to be string here
      const connection = await ensureInboundConnection({
        tenantId: tenantId as string,
        marketplace: marketplace,
        countries: countries,
      });
      
      if (!connection) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: "Failed to create connection",
        });
      }
      
      return reply.send(connection);
      
    } catch (error) {
      console.error("[InboundEmail] Error creating connection:", error);
      
      const err = error as { code?: string; message?: string };
      
      // Handle Prisma errors
      if (err.code === 'P2002') {
        return reply.status(409).send({
          error: "Conflict",
          message: "Connection already exists for this tenant and marketplace",
        });
      }
      
      if (err.code && err.code.startsWith('P')) {
        return reply.status(400).send({
          error: "Database Error",
          message: err.message || "Database operation failed",
        });
      }
      
      // Generic error
      return reply.status(500).send({
        error: "Internal Server Error",
        message: err.message || "Failed to create connection",
      });
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
      const user = request.user;

      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      if (!country) {
        return reply.status(400).send({ error: "Missing country" });
      }

      // Verify connection belongs to tenant
      const connection = await prisma.inboundConnection.findUnique({
        where: { id, tenantId: user.tenantId },
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
      const user = request.user;

      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      // Verify address belongs to tenant
      const address = await prisma.inboundAddress.findUnique({
        where: { id, tenantId: user.tenantId },
      });

      if (!address) {
        return reply.status(404).send({ error: "Address not found" });
      }

      const result = await regenerateToken(id);

      return reply.send({ success: true, emailAddress: result.emailAddress });
    } catch (error) {
      console.error("[InboundEmail] Error regenerating token:", error);
      return reply.status(500).send({ error: "Failed to regenerate token", details: (error as Error).message });
    }
  });

  /**
   * GET /api/v1/inbound-email/health
   * Get health indicators (mock for now)
   */
  server.get("/api/v1/inbound-email/health", async (_request, reply) => {
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
  /**
   * GET /api/v1/inbound-email/health/:connectionId
   * Get real health checks for specific connection
   */
  server.get("/api/v1/inbound-email/health/:connectionId", async (request, reply) => {
    try {
      const { connectionId } = request.params as { connectionId: string };
      const user = request.user;

      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      // Verify connection belongs to tenant
      const connection = await prisma.inboundConnection.findUnique({
        where: { id: connectionId, tenantId: user.tenantId },
      });

      if (!connection) {
        return reply.status(404).send({ error: "Connection not found" });
      }

      // Get all health checks
      const indicators = await getAllHealthChecks(connectionId, user.tenantId);

      return reply.send({
        connectionId,
        status: connection.status,
        actionMessage: "Check indicators for details",
        indicators,
      });
    } catch (error) {
      console.error("[InboundEmail] Error getting health:", error);
      return reply.status(500).send({ error: "Failed to get health status" });
    }
  });

  /**
   * POST /api/v1/inbound-email/dev/seed
   * Create demo connection with test data (DEV only)
   */
  server.post("/api/v1/inbound-email/dev/seed", {
    schema: {
      body: {
        type: ['object', 'null'],
        nullable: true
      }
    }
  }, async (request, reply) => {
    try {
      // Only allow in non-production
      if (process.env.NODE_ENV === "production") {
        return reply.status(403).send({ error: "Not available in production" });
      }

      const user = request.user;
      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      // Check if demo connection already exists
      const existing = await prisma.inboundConnection.findFirst({
        where: {
          tenantId: user.tenantId,
          marketplace: "AMAZON",
        },
      });

      if (existing) {
        return reply.send({
          message: "Demo connection already exists",
          connectionId: existing.id,
        });
      }

      // Create demo connection with correct signature
      const connection = await ensureInboundConnection({
        tenantId: user.tenantId,
        marketplace: "AMAZON",
        countries: ["FR", "DE", "UK"],
      });

      return reply.send({
        message: "Demo connection created",
        connectionId: connection?.id,
      });
    } catch (error) {
      console.error("[InboundEmail] Error seeding demo:", error);
      return reply.status(500).send({ error: "Failed to create demo connection" });
    }
  });

}

