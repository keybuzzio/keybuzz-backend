/**
 * API Endpoints Inbound Email Management
 * PH11-06B.5A
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from "fastify";
import { getAllHealthChecks } from "../inbound/inboundHealth.service";
import { prisma } from "../../lib/db";
import { ensureInboundConnection } from "./inboundEmailAddress.service";
import { CreateConnectionSchema } from "./inboundEmail.validation";
import { sendValidationEmail, regenerateToken } from "./inboundEmailValidation.service";

/**
 * JWT Authentication preHandler (local to this plugin)
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.status(401).send({ error: "Unauthorized", details: (err as Error).message });
  }
}

/**
 * Plugin with all inbound email routes (encapsulated)
 */
async function inboundEmailPlugin(server: FastifyInstance, _opts: FastifyPluginOptions) {
  // Apply JWT authentication ONLY to this encapsulated scope
  server.addHook("preHandler", authenticate);

  /**
   * GET /connections
   * List all inbound connections for tenant
   */
  server.get("/connections", async (request, reply) => {
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

      const connectionsWithSummary = connections.map((conn) => ({
        ...conn,
        inboundAddressesCount: conn.addresses.length,
        validatedCount: conn.addresses.filter((a) => a.marketplaceStatus === "VALIDATED").length,
        pendingCount: conn.addresses.filter((a) => a.marketplaceStatus === "PENDING").length,
        failedCount: conn.addresses.filter((a) => a.marketplaceStatus === "FAILED").length,
      }));

      return reply.send({ connections: connectionsWithSummary });
    } catch (error) {
      console.error("[InboundEmail] Error listing connections:", error);
      return reply.status(500).send({ error: "Failed to list connections" });
    }
  });

  /**
   * GET /connections/:id
   */
  server.get("/connections/:id", async (request, reply) => {
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

      const connectionWithSummary = {
  ...connection,
  addresses: connection.addresses.map((a) => ({
    ...a,
    pipelineStatus: (a.pipelineStatus ?? (a.validationStatus === 'VALIDATED' ? 'VALIDATED' : 'PENDING')),
    marketplaceStatus: (a.marketplaceStatus ?? 'PENDING'),
  })),
        inboundAddressesCount: connection.addresses.length,
        validatedCount: connection.addresses.filter((a) => a.marketplaceStatus === "VALIDATED").length,
        pendingCount: connection.addresses.filter((a) => a.marketplaceStatus === "PENDING").length,
        failedCount: connection.addresses.filter((a) => a.marketplaceStatus === "FAILED").length,
};

      return reply.send(connectionWithSummary);
    } catch (error) {
      console.error("[InboundEmail] Error getting connection:", error);
      return reply.status(500).send({ error: "Failed to get connection" });
    }
  });

  /**
   * POST /connections
   */
  server.post("/connections", async (request, reply) => {
    try {
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
      
      const user = request.user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      
      const userRole = user.role;
      const userTenantId = user.tenantId;
      
      if (userRole === "super_admin" || userRole === "SUPER_ADMIN") {
        if (!tenantId) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "tenantId is required for super_admin role",
          });
        }
        
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
        if (!userTenantId) {
          return reply.status(403).send({
            error: "Forbidden",
            message: "No tenantId associated with your account",
          });
        }
        tenantId = userTenantId;
      }
      
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
      
      return reply.status(500).send({
        error: "Internal Server Error",
        message: err.message || "Failed to create connection",
      });
    }
  });

  /**
   * POST /connections/:id/validate
   */
  server.post("/connections/:id/validate", async (request, reply) => {
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
   * POST /addresses/:id/regenerate
   */
  server.post("/addresses/:id/regenerate", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const user = request.user;

      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

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
   * GET /health (public health mock)
   */
  server.get("/health", async (_request, reply) => {
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
   * GET /health/:connectionId
   */
  server.get("/health/:connectionId", async (request, reply) => {
    try {
      const { connectionId } = request.params as { connectionId: string };
      const user = request.user;

      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      const connection = await prisma.inboundConnection.findUnique({
        where: { id: connectionId, tenantId: user.tenantId },
      });

      if (!connection) {
        return reply.status(404).send({ error: "Connection not found" });
      }

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
   * POST /dev/seed (DEV only)
   */
  server.post("/dev/seed", {
    schema: {
      body: {
        type: ['object', 'null'],
        nullable: true
      }
    }
  }, async (request, reply) => {
    try {
      if (process.env.NODE_ENV === "production") {
        return reply.status(403).send({ error: "Not available in production" });
      }

      const user = request.user;
      if (!user || !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

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

// Export as function that registers with prefix (creates encapsulated scope)
export async function registerInboundEmailRoutes(server: FastifyInstance) {
  await server.register(inboundEmailPlugin, { prefix: '/api/v1/inbound-email' });
}