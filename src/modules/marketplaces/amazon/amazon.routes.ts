// src/modules/marketplaces/amazon/amazon.routes.ts

import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../../../lib/db";
import { env } from "../../../config/env";
import { ensureAmazonConnection } from "./amazon.service";
import { pollAmazonForTenant } from "./amazon.poller";
import { MarketplaceType } from "@prisma/client";
import type { AuthUser } from "../../auth/auth.types";

export async function registerAmazonRoutes(server: FastifyInstance) {
  /**
   * GET /api/v1/marketplaces/amazon/status
   * Get Amazon connection status for current tenant
   */
  server.get(
    "/api/v1/marketplaces/amazon/status",
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const connection = await prisma.marketplaceConnection.findFirst({
        where: {
          tenantId: user.tenantId,
          type: MarketplaceType.AMAZON,
        },
      });

      if (!connection) {
        return reply.status(404).send({
          error: "No Amazon connection found",
          connected: false,
        });
      }

      return reply.send({
        connected: connection.status === "CONNECTED",
        status: connection.status,
        displayName: connection.displayName,
        region: connection.region,
        lastSyncAt: connection.lastSyncAt,
        lastError: connection.lastError,
      });
    }
  );

  /**
   * POST /api/v1/marketplaces/amazon/connect
   * Placeholder for self-serve connect (OAuth in PH11-06B)
   */
  server.post(
    "/api/v1/marketplaces/amazon/connect",
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // TODO PH11-06B: Implement OAuth flow
      // For now, create/update connection as PENDING

      const existing = await prisma.marketplaceConnection.findFirst({
        where: {
          tenantId: user.tenantId,
          type: MarketplaceType.AMAZON,
        },
      });

      const connection = existing
        ? await prisma.marketplaceConnection.update({
            where: { id: existing.id },
            data: {
              status: "PENDING",
              updatedAt: new Date(),
            },
          })
        : await prisma.marketplaceConnection.create({
            data: {
              tenantId: user.tenantId,
              type: MarketplaceType.AMAZON,
              status: "PENDING",
              displayName: "Amazon",
            },
          });

      return reply.send({
        message: "Amazon connection initiated",
        status: "pending",
        instructions:
          "OAuth flow will be implemented in PH11-06B. For now, connection is marked as PENDING.",
        connectionId: connection.id,
      });
    }
  );

  /**
   * POST /api/v1/marketplaces/amazon/mock/connect
   * Dev-only: Create CONNECTED connection for mock polling
   */
  server.post(
    "/api/v1/marketplaces/amazon/mock/connect",
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      // Check dev mode
      const isDevMode =
        env.NODE_ENV === "development" ||
        process.env.KEYBUZZ_DEV_MODE === "true";

      if (!isDevMode) {
        return reply.status(403).send({
          error: "This endpoint is only available in development mode",
        });
      }

      const connection = await ensureAmazonConnection(user.tenantId);

      // Trigger immediate poll
      try {
        await pollAmazonForTenant(user.tenantId);
      } catch (err) {
        console.error("Error polling after mock connect:", err);
      }

      return reply.send({
        message: "Mock Amazon connection created and polled",
        connectionId: connection.id,
        status: connection.status,
      });
    }
  );
}

