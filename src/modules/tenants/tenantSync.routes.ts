/**
 * PH15-TENANT-SYNC-01
 * Endpoint to sync tenant from product DB to marketplace DB
 */
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { prisma } from "../../lib/db";
import { productDb } from "../../lib/productDb";

interface TenantSyncPayload {
  tenantId: string;
  name?: string;
  slug?: string;
  plan?: string;
  status?: string;
  createInboundAddress?: boolean;
  country?: string;
}

async function tenantSyncPlugin(server: FastifyInstance, _opts: FastifyPluginOptions) {
  
  /**
   * POST /sync
   * Sync a tenant from product DB to marketplace DB
   * Internal use only (X-Internal-Key auth)
   */
  server.post("/sync", async (request, reply) => {
    const internalKey = String(request.headers["x-internal-key"] ?? "");
    const expectedKey = process.env.INBOUND_WEBHOOK_KEY ?? "";
    
    // Allow dev mode without key
    const isDevMode = process.env.KEYBUZZ_DEV_MODE === "true";
    if (!isDevMode && (!expectedKey || internalKey !== expectedKey)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      const payload = request.body as TenantSyncPayload;
      
      if (!payload.tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }

      const { tenantId, createInboundAddress = true, country = "FR" } = payload;

      // Check if tenant exists in marketplace DB
      let tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (tenant) {
        console.log(`[TenantSync] Tenant ${tenantId} already exists in marketplace DB`);
        
        // Update if needed
        if (payload.name || payload.plan || payload.status) {
          tenant = await prisma.tenant.update({
            where: { id: tenantId },
            data: {
              ...(payload.name && { name: payload.name }),
              ...(payload.plan && { plan: payload.plan.toUpperCase() as any }),
              ...(payload.status && { status: payload.status.toUpperCase() as any }),
            },
          });
        }
      } else {
        // Fetch tenant info from product DB
        const productTenant = await productDb.query(
          `SELECT id, name, plan, status FROM tenants WHERE id = $1`,
          [tenantId]
        );

        if (productTenant.rows.length === 0) {
          return reply.code(404).send({ error: "Tenant not found in product DB" });
        }

        const pt = productTenant.rows[0];
        
        // Create tenant in marketplace DB
        tenant = await prisma.tenant.create({
          data: {
            id: tenantId,
            slug: payload.slug || tenantId.replace(/_/g, "-").toLowerCase(),
            name: payload.name || pt.name,
            plan: (payload.plan || pt.plan || "DEV").toUpperCase() as any,
            status: (payload.status || pt.status || "ACTIVE").toUpperCase() as any,
          },
        });

        console.log(`[TenantSync] Created tenant ${tenantId} in marketplace DB`);
      }

      // Create inbound connection and address if requested
      let inboundAddress = null;
      if (createInboundAddress) {
        // Check if inbound connection exists
        let connection = await prisma.inboundConnection.findUnique({
          where: {
            tenantId_marketplace: {
              tenantId,
              marketplace: "amazon",
            },
          },
        });

        if (!connection) {
          connection = await prisma.inboundConnection.create({
            data: {
              tenantId,
              marketplace: "amazon",
              countries: [country],
              status: "DRAFT",
            },
          });
          console.log(`[TenantSync] Created inbound connection for ${tenantId}`);
        }

        // Check if inbound address exists
        let address = await prisma.inboundAddress.findUnique({
          where: {
            tenantId_marketplace_country: {
              tenantId,
              marketplace: "AMAZON",
              country,
            },
          },
        });

        if (!address) {
          // Generate token
          const token = generateToken(6);
          const emailAddress = `amazon.${tenantId}.${country.toLowerCase()}.${token}@inbound.keybuzz.io`;
          
          address = await prisma.inboundAddress.create({
            data: {
              tenantId,
              connectionId: connection.id,
              marketplace: "AMAZON",
              country,
              token,
              emailAddress,
              pipelineStatus: "PENDING",
            },
          });
          console.log(`[TenantSync] Created inbound address: ${emailAddress}`);
        }

        inboundAddress = address.emailAddress;
      }

      return reply.send({
        success: true,
        tenant: {
          id: tenant.id,
          name: tenant.name,
          plan: tenant.plan,
          status: tenant.status,
        },
        inboundAddress,
      });

    } catch (error) {
      console.error("[TenantSync] Error:", error);
      return reply.code(500).send({ 
        error: "Failed to sync tenant",
        details: (error as Error).message,
      });
    }
  });

  /**
   * POST /sync-all
   * Sync all tenants from product DB to marketplace DB
   * Internal use only
   */
  server.post("/sync-all", async (request, reply) => {
    const internalKey = String(request.headers["x-internal-key"] ?? "");
    const expectedKey = process.env.INBOUND_WEBHOOK_KEY ?? "";
    
    const isDevMode = process.env.KEYBUZZ_DEV_MODE === "true";
    if (!isDevMode && (!expectedKey || internalKey !== expectedKey)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    try {
      // Get all tenants from product DB
      const productTenants = await productDb.query(
        `SELECT id, name, plan, status FROM tenants WHERE status != 'archived'`
      );

      const results = {
        created: [] as string[],
        updated: [] as string[],
        skipped: [] as string[],
        errors: [] as { id: string; error: string }[],
      };

      for (const pt of productTenants.rows) {
        try {
          const existing = await prisma.tenant.findUnique({
            where: { id: pt.id },
          });

          if (existing) {
            results.skipped.push(pt.id);
          } else {
            await prisma.tenant.create({
              data: {
                id: pt.id,
                slug: pt.id.replace(/_/g, "-").toLowerCase(),
                name: pt.name,
                plan: (pt.plan || "DEV").toUpperCase() as any,
                status: (pt.status || "ACTIVE").toUpperCase() as any,
              },
            });
            results.created.push(pt.id);
          }
        } catch (err) {
          results.errors.push({ id: pt.id, error: (err as Error).message });
        }
      }

      return reply.send({
        success: true,
        total: productTenants.rows.length,
        results,
      });

    } catch (error) {
      console.error("[TenantSync] Error:", error);
      return reply.code(500).send({ 
        error: "Failed to sync tenants",
        details: (error as Error).message,
      });
    }
  });

  /**
   * GET /status/:tenantId
   * Check tenant sync status
   */
  server.get("/status/:tenantId", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    try {
      // Check product DB
      const productResult = await productDb.query(
        `SELECT id, name, plan, status FROM tenants WHERE id = $1`,
        [tenantId]
      );
      const productTenant = productResult.rows[0] || null;

      // Check marketplace DB
      const marketplaceTenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      // Check inbound addresses
      const inboundAddresses = await prisma.inboundAddress.findMany({
        where: { tenantId },
      });

      // Check marketplace connections
      const marketplaceConnections = await prisma.marketplaceConnection.findMany({
        where: { tenantId },
      });

      return reply.send({
        tenantId,
        product: productTenant ? {
          exists: true,
          name: productTenant.name,
          plan: productTenant.plan,
          status: productTenant.status,
        } : { exists: false },
        marketplace: marketplaceTenant ? {
          exists: true,
          name: marketplaceTenant.name,
          plan: marketplaceTenant.plan,
          status: marketplaceTenant.status,
        } : { exists: false },
        inSync: !!(productTenant && marketplaceTenant),
        inboundAddresses: inboundAddresses.map(a => ({
          marketplace: a.marketplace,
          country: a.country,
          email: a.emailAddress,
          status: a.pipelineStatus,
        })),
        marketplaceConnections: marketplaceConnections.map(c => ({
          type: c.type,
          status: c.status,
          displayName: c.displayName,
        })),
      });

    } catch (error) {
      console.error("[TenantSync] Error:", error);
      return reply.code(500).send({ 
        error: "Failed to check sync status",
        details: (error as Error).message,
      });
    }
  });
}

function generateToken(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export async function registerTenantSyncRoutes(server: FastifyInstance) {
  await server.register(tenantSyncPlugin, { prefix: "/api/v1/tenants" });
}
