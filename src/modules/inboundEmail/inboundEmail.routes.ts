import { getAmazonPollingHealth } from "./amazonPollingHealth.service";
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


/**
 * Helper: Build tenant filter for queries
 * super_admin can see all, others are filtered by tenantId
 */
function getTenantFilter(user: any): { tenantId?: string } {
  if (user?.role === "super_admin") {
    return {}; // No filter for super_admin
  }
  return { tenantId: user?.tenantId };
}

/**
 * Helper: Assert tenant access
 * super_admin can access any, others must match tenantId
 */
function assertTenantAccess(user: any, resourceTenantId: string): boolean {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  if (!user.tenantId) return false;
  return user.tenantId === resourceTenantId;
}

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
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // super_admin can list all, others need tenantId
      if (user.role !== "super_admin" && !user.tenantId) {
        return reply.status(403).send({ error: "Forbidden: no tenantId" });
      }

      const connections = await prisma.inboundConnection.findMany({
        where: getTenantFilter(user),
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
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const connection = await prisma.inboundConnection.findUnique({
        where: { id },
        include: {
          addresses: true,
          tenant: { select: { name: true } },
        },
      });

      if (!connection) {
        return reply.status(404).send({ error: "Connection not found" });
      }

      // Check tenant access
      if (!assertTenantAccess(user, connection.tenantId)) {
        return reply.status(403).send({ error: "Forbidden: tenant mismatch" });
      }
      // Find Amazon MarketplaceConnection for this tenant
      const amazonMarketplaceConnection = await prisma.marketplaceConnection.findFirst({
        where: {
          tenantId: connection.tenantId,
          type: "AMAZON",
        },
        orderBy: { updatedAt: "desc" },
      });

      const connectionWithSummary = {
  ...connection,
  addresses: connection.addresses.map((a) => ({
    ...a,
    pipelineStatus: (a.pipelineStatus ?? (a.validationStatus === 'VALIDATED' ? 'VALIDATED' : 'PENDING')),
    marketplaceStatus: (a.marketplaceStatus ?? 'PENDING'),
    marketplaceConfiguredAt: (a as any).marketplaceConfiguredAt ?? null,
    marketplaceConfiguredBy: (a as any).marketplaceConfiguredBy ?? null,
    marketplaceConfigNote: (a as any).marketplaceConfigNote ?? null,
  })),
        inboundAddressesCount: connection.addresses.length,
        validatedCount: connection.addresses.filter((a) => a.marketplaceStatus === "VALIDATED").length,
        pendingCount: connection.addresses.filter((a) => a.marketplaceStatus === "PENDING").length,
        failedCount: connection.addresses.filter((a) => a.marketplaceStatus === "FAILED").length,
        amazonMarketplaceConnectionId: amazonMarketplaceConnection?.id || null,
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
        where: { id },
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
  /**
   * GET /health/:connectionId
   * Returns health status for a specific connection including Amazon Polling
   * PH11-06B.7.1: Enhanced with amazonPolling status
   */
  server.get("/health/:connectionId", async (request, reply) => {
    const { connectionId } = request.params as { connectionId: string };

    try {
      // Get inbound connection
      const connection = await prisma.inboundConnection.findUnique({
        where: { id: connectionId },
        include: {
          addresses: true,
        },
      });

      if (!connection) {
        return reply.status(404).send({ error: "Connection not found" });
      }

      // Check tenant access (super_admin can access all)
      const user = request.user;
      if (!assertTenantAccess(user, connection.tenantId)) {
        return reply.status(403).send({ error: "Forbidden: tenant mismatch" });
      }

      // Calculate inbound health
      const addresses = connection.addresses || [];
      const validatedCount = addresses.filter(a => a.pipelineStatus === "VALIDATED").length;
      const totalCount = addresses.length;
      
      // Get Amazon Polling health - PH11-06B.7.1
      const amazonPolling = await getAmazonPollingHealth(connectionId);

      // Determine overall status
      let overallStatus: "OK" | "WARNING" | "ERROR" = "OK";
      if (amazonPolling.status === "ERROR") {
        overallStatus = "ERROR";
      } else if (amazonPolling.status === "WARNING" || validatedCount < totalCount) {
        overallStatus = "WARNING";
      }

      return reply.send({
        connectionId,
        status: overallStatus,
        inbound: {
          totalAddresses: totalCount,
          validatedAddresses: validatedCount,
          pipelineHealthy: validatedCount === totalCount,
        },
        amazonPolling: {
          status: amazonPolling.status,
          message: amazonPolling.message,
          oauthConnected: amazonPolling.oauthConnected,
          lastRunAt: amazonPolling.lastRunAt || null,
          lastSuccessAt: amazonPolling.lastSuccessAt || null,
          lastError: amazonPolling.lastError || null,
          reason: amazonPolling.reason || null,
          isMockMode: amazonPolling.isMockMode,
          jobsLast24h: amazonPolling.jobsLast24h || null,
        },
        timestamp: new Date().toISOString(),
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
  /**
   * POST /addresses/:id/mark-configured
   * Mark an inbound address as configured in Seller Central
   */
  server.post("/addresses/:id/mark-configured", async (request, reply) => {
    try {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const { id } = request.params as { id: string };
      const body = request.body as { note?: string } || {};

      // Find the address
      const address = await prisma.inboundAddress.findUnique({
        where: { id },
        include: { connection: true },
      });

      if (!address) {
        return reply.status(404).send({ error: "Address not found" });
      }

      // Check tenant access
      if (!assertTenantAccess(user, address.connection.tenantId)) {
        return reply.status(403).send({ error: "Forbidden: tenant mismatch" });
      }

      // Update using raw SQL to bypass Prisma type errors
      const configuredBy = user.email || user.userId || "unknown";
      const configNote = body.note || null;
      
      await prisma.$executeRaw`
        UPDATE "inbound_addresses"
        SET "marketplaceConfiguredAt" = NOW(),
            "marketplaceConfiguredBy" = ${configuredBy},
            "marketplaceConfigNote" = ${configNote}
        WHERE id = ${id}
      `;

      // Fetch updated address
      const updated = await prisma.inboundAddress.findUnique({
        where: { id },
      }) as any;

      return reply.send({
        success: true,
        addressId: updated.id,
        marketplaceConfiguredAt: updated.marketplaceConfiguredAt,
      });
    } catch (error) {
      console.error("[InboundEmail] Error marking address as configured:", error);
      return reply.status(500).send({ error: "Failed to mark address as configured" });
    }
  });

  /**
   * GET /addresses/:id/test-instructions
   * Get test instructions for an inbound address
   */
  server.get("/addresses/:id/test-instructions", async (request, reply) => {
    try {
      const user = (request as any).user;
      if (!user) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const { id } = request.params as { id: string };

      // Find the address
      const address = await prisma.inboundAddress.findUnique({
        where: { id },
        include: { connection: true },
      });

      if (!address) {
        return reply.status(404).send({ error: "Address not found" });
      }

      // Check tenant access
      if (!assertTenantAccess(user, address.connection.tenantId)) {
        return reply.status(403).send({ error: "Forbidden: tenant mismatch" });
      }

      // Generate short token for test (first 8 chars of token)
      const shortToken = address.token.substring(0, 8).toUpperCase();

      // Generate test instructions
      const instructions = {
        country: address.country,
        emailAddress: address.emailAddress,
        marketplace: address.marketplace,
        subjectTemplate: `KBZ AMAZON FWD TEST ${address.country} ${shortToken}`,
        copyMessageTemplate: `This is a test message to verify Amazon forwarding is working correctly.\n\nToken: ${shortToken}\nCountry: ${address.country}\nMarketplace: ${address.marketplace}\n\nPlease forward this message to confirm the setup.`,
        steps: [
          "Go to Amazon Seller Central",
          `Add the email address: ${address.emailAddress}`,
          `Send a test email with subject: KBZ AMAZON FWD TEST ${address.country} ${shortToken}`,
          "Wait for Amazon to forward the message",
          "Check the status in KeyBuzz - it should turn green automatically",
        ],
        expectedResult: "Once Amazon forwards the test message, the marketplaceStatus will automatically change to VALIDATED and you'll see the message in KeyBuzz.",
      };

      return reply.send(instructions);
    } catch (error) {
      console.error("[InboundEmail] Error getting test instructions:", error);
      return reply.status(500).send({ error: "Failed to get test instructions" });
    }
  });


}

// Export as function that registers with prefix (creates encapsulated scope)
export async function registerInboundEmailRoutes(server: FastifyInstance) {
  await server.register(inboundEmailPlugin, { prefix: '/api/v1/inbound-email' });
}