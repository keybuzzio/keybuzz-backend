// src/modules/marketplaces/amazon/amazon.routes.ts

import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../../../lib/db";
import { env } from "../../../config/env";
import { ensureAmazonConnection } from "./amazon.service";
import { pollAmazonForTenant } from "./amazon.poller";
import { MarketplaceType } from "@prisma/client";
import type { AuthUser } from "../../auth/auth.types";
import { generateAmazonOAuthUrl, completeAmazonOAuth } from "./amazon.oauth";

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
   * POST /api/v1/marketplaces/amazon/oauth/start
   * Start Amazon OAuth flow (self-serve)
   */
  server.post(
    "/api/v1/marketplaces/amazon/oauth/start",
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      try {
        // Ensure connection exists (create if needed)
        const existing = await prisma.marketplaceConnection.findFirst({
          where: {
            tenantId: user.tenantId,
            type: MarketplaceType.AMAZON,
          },
        });

        if (!existing) {
          await prisma.marketplaceConnection.create({
            data: {
              tenantId: user.tenantId,
              type: MarketplaceType.AMAZON,
              status: "PENDING",
              displayName: "Amazon",
            },
          });
        }

        // Generate OAuth URL
        const oauthData = await generateAmazonOAuthUrl(user.tenantId);

        return reply.send({
          authUrl: oauthData.authUrl,
          expiresAt: oauthData.expiresAt,
          message: "Redirect user to authUrl to authorize Amazon connection",
        });
      } catch (error) {
        console.error("[Amazon OAuth] Error starting OAuth:", error);
        return reply.status(500).send({
          error: "Failed to start Amazon OAuth",
          details: (error as Error).message,
        });
      }
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

  /**
   * GET /api/v1/marketplaces/amazon/oauth/callback
   * Amazon OAuth callback (handles redirect from Amazon)
   */
  server.get(
    "/api/v1/marketplaces/amazon/oauth/callback",
    async (request, reply) => {
      const query = request.query as {
        code?: string;
        state?: string;
        selling_partner_id?: string;
        spapi_oauth_code?: string;
        error?: string;
        error_description?: string;
      };

      // Check for errors from Amazon
      if (query.error) {
        console.error(
          `[Amazon OAuth] Authorization failed: ${query.error} - ${query.error_description}`
        );
        return reply.status(400).send({
          error: "Amazon authorization failed",
          details: query.error_description || query.error,
        });
      }

      // Amazon sends both 'code' (LWA) and 'spapi_oauth_code' (SP-API)
      const authCode = query.spapi_oauth_code || query.code;
      const state = query.state;
      const sellingPartnerId = query.selling_partner_id;

      if (!authCode || !state || !sellingPartnerId) {
        return reply.status(400).send({
          error: "Missing required OAuth parameters",
          details: "code, state, or selling_partner_id missing",
        });
      }

      try {
        // Extract tenantId from state (format: <uuid>-<tenantId>)
        // For now, we need to find the tenant by state lookup
        const syncState = await prisma.marketplaceSyncState.findFirst({
          where: {
            cursor: state,
            type: MarketplaceType.AMAZON,
          },
        });

        if (!syncState) {
          return reply.status(400).send({
            error: "Invalid or expired state",
            details: "OAuth state not found or expired",
          });
        }

        // Complete OAuth flow
        await completeAmazonOAuth({
          tenantId: syncState.tenantId,
          code: authCode,
          state,
          sellingPartnerId,
        });

        // Success: redirect to success page or return JSON
        return reply.send({
          success: true,
          message: "Amazon connection successful",
          sellingPartnerId,
        });
      } catch (error) {
        console.error("[Amazon OAuth] Callback error:", error);
        return reply.status(500).send({
          error: "Failed to complete Amazon OAuth",
          details: (error as Error).message,
        });
      }
    }
  );
}

