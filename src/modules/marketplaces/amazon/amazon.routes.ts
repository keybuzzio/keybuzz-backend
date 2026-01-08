// src/modules/marketplaces/amazon/amazon.routes.ts

import type { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../../../lib/db";
import { env } from "../../../config/env";
import { ensureAmazonConnection } from "./amazon.service";
import { pollAmazonForTenant } from "./amazon.poller";
import { MarketplaceType, Prisma } from "@prisma/client";
import type { AuthUser } from "../../auth/auth.types";
import { generateAmazonOAuthUrl, completeAmazonOAuth } from "./amazon.oauth";
import { devAuthenticateOrJwt } from "../../../lib/devAuthMiddleware";

export async function registerAmazonRoutes(server: FastifyInstance) {
  /**
   * Authentication preHandler - uses DEV bridge (X-User-Email) or JWT
   */
  const authenticate = devAuthenticateOrJwt;
  
  /**
   * GET /api/v1/marketplaces/amazon/status
   * Get Amazon connection status for current tenant
   */
  server.get(
    "/api/v1/marketplaces/amazon/status",
    { preHandler: authenticate },
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
        // Return DISCONNECTED status instead of 404 for wizard compatibility
        return reply.send({
          connected: false,
          status: "DISCONNECTED",
          displayName: null,
          region: null,
          lastSyncAt: null,
          lastError: null,
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
   * Accepts: { tenantId?: string, connectionId?: string }
   */
  server.post(
    "/api/v1/marketplaces/amazon/oauth/start",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      try {
        const body = request.body as { tenantId?: string; connectionId?: string };
        
        // Determine tenantId: super_admin can specify, others use their own
        let targetTenantId: string;
        if (user.role === "super_admin" && body.tenantId) {
          targetTenantId = body.tenantId;
        } else {
          targetTenantId = user.tenantId;
        }

        // Resolve MarketplaceConnection: connectionId is optional if tenantId is provided
        // Priority: CONNECTED > PENDING > most recent
        let connection;
        if (body.connectionId) {
          // Verify connection exists and belongs to tenant
          connection = await prisma.marketplaceConnection.findFirst({
            where: {
              id: body.connectionId,
              tenantId: targetTenantId,
              type: MarketplaceType.AMAZON,
            },
          });
          if (!connection) {
            return reply.status(404).send({
              error: "MarketplaceConnection not found or does not belong to tenant",
            });
          }
        } else {
          // Find Amazon MarketplaceConnection for tenant (priority: CONNECTED > PENDING > most recent)
          connection = await prisma.marketplaceConnection.findFirst({
            where: {
              tenantId: targetTenantId,
              type: MarketplaceType.AMAZON,
            },
            orderBy: { updatedAt: "desc" },
          });
          
          // If no connection exists, create one
          if (!connection) {
            connection = await prisma.marketplaceConnection.create({
              data: {
                tenantId: targetTenantId,
                type: MarketplaceType.AMAZON,
                status: "PENDING",
                displayName: "Amazon (pending)",
                region: "EU",
              },
            });
          }
        }

        // Generate OAuth URL with connectionId
        const oauthData = await generateAmazonOAuthUrl(targetTenantId, connection.id);

        return reply.send({
          success: true,
          authUrl: oauthData.authUrl,
          state: oauthData.state,
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
   * POST /api/v1/marketplaces/amazon/disconnect
   * Disconnect Amazon connection for current tenant
   */
  server.post(
    "/api/v1/marketplaces/amazon/disconnect",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply) => {
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      try {
        const connection = await prisma.marketplaceConnection.findFirst({
          where: {
            tenantId: user.tenantId,
            type: MarketplaceType.AMAZON,
          },
        });

        if (!connection) {
          return reply.status(404).send({
            error: "No Amazon connection found",
          });
        }

        // Update status to DISABLED (represents disconnected)
        await prisma.marketplaceConnection.update({
          where: { id: connection.id },
          data: {
            status: "DISABLED",
            lastError: "Disconnected by user",
          },
        });

        // TODO: Delete refresh token from Vault if stored there
        // For now, just mark as disconnected in DB

        return reply.send({
          success: true,
          message: "Amazon connection disconnected",
          previousStatus: connection.status,
        });
      } catch (error) {
        console.error("[Amazon] Error disconnecting:", error);
        return reply.status(500).send({
          error: "Failed to disconnect Amazon",
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
    { preHandler: authenticate },
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
   * PUBLIC - no authentication required (Amazon redirects here)
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
          `[Amazon OAuth] Authorization failed: ${query.error} - ${query.error_description}`);
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
        // Resolve state → (tenantId, connectionId) from OAuthState
        const oauthStateResult = await prisma.$queryRaw<Array<{id: string; tenantId: string; connectionId: string; expiresAt: Date; usedAt: Date | null}>>`SELECT id, "tenantId", "connectionId", "expiresAt", "usedAt"
          FROM "OAuthState"
          WHERE "marketplaceType" = ${MarketplaceType.AMAZON}::"MarketplaceType"
          AND state = ${state}
          LIMIT 1`;
        const oauthState = oauthStateResult[0] || null;

        // Hard fails
        if (!oauthState) {
          return reply.status(400).send({
            error: "invalid_state",
            details: "OAuth state not found",
          });
        }

        if (oauthState.expiresAt < new Date()) {
          return reply.status(400).send({
            error: "expired_state",
            details: "OAuth state has expired",
          });
        }

        if (oauthState.usedAt) {
          return reply.status(400).send({
            error: "state_already_used",
            details: "OAuth state has already been used",
          });
        }

        // Complete OAuth flow with tenantId + connectionId from OAuthState
        await completeAmazonOAuth({
          tenantId: oauthState.tenantId,
          connectionId: oauthState.connectionId,
          code: authCode,
          state,
          sellingPartnerId,
        });

        // Mark state as used
        await prisma.$executeRaw`UPDATE "OAuthState"
          SET "usedAt" = NOW()
          WHERE id = ${oauthState.id}`;

        // Redirect to client with success
        const clientUrl = process.env.CLIENT_CALLBACK_URL || "https://client-dev.keybuzz.io/onboarding";
        return reply.redirect(`${clientUrl}?amazon_connected=true&tenant_id=${oauthState.tenantId}`);
      } catch (error) {
        console.error("[Amazon OAuth] Callback error:", error);
        // Redirect to client with error
        const clientUrl = process.env.CLIENT_CALLBACK_URL || "https://client-dev.keybuzz.io/onboarding";
        const errorMsg = encodeURIComponent((error as Error).message);
        return reply.redirect(`${clientUrl}?amazon_error=${errorMsg}`);
      }
    }
  );
}
