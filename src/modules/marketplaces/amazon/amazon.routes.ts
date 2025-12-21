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
   * Accepts: { tenantId?: string, connectionId: string }
   */
  server.post(
    "/api/v1/marketplaces/amazon/oauth/start",
    async (request: FastifyRequest, reply) => {
      await request.jwtVerify();
      const user = (request as FastifyRequest & { user: AuthUser }).user;
      
      if (!user || !user.tenantId) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      try {
        const body = request.body as { tenantId?: string; connectionId?: string; returnTo?: string };
        
        // Determine tenantId: super_admin can specify, others use their own
        let targetTenantId: string;
        if (user.role === "super_admin") {
          if (!body.tenantId) {
            return reply.status(400).send({
              error: "tenantId required for super_admin",
            });
          }
          targetTenantId = body.tenantId;
        } else {
          targetTenantId = user.tenantId; // Ignore body.tenantId for non-super_admin
        }

        // connectionId is required
        if (!body.connectionId) {
          return reply.status(400).send({
            error: "connectionId is required",
          });
        }

        // Verify connection exists and belongs to tenant
        const connection = await prisma.marketplaceConnection.findFirst({
          where: {
            id: body.connectionId,
            tenantId: targetTenantId,
            type: MarketplaceType.AMAZON,
          },
        });

        if (!connection) {
          return reply.status(404).send({
            error: "Connection not found or does not belong to tenant",
          });
        }

        // Generate OAuth URL with connectionId and returnTo (if provided)
        const oauthData = await generateAmazonOAuthUrl(targetTenantId, body.connectionId, body.returnTo);

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

      const redirectBase = process.env.ADMIN_UI_BASE_URL || "https://admin-dev.keybuzz.io";

      // Check for errors from Amazon
      if (query.error) {
        console.error(
          `[Amazon OAuth] Authorization failed: ${query.error} - ${query.error_description}`
        );
        const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=0&error=amazon_authorization_failed`;
        return reply.code(302).redirect(redirectUrl);
      }

      // Amazon sends both 'code' (LWA) and 'spapi_oauth_code' (SP-API)
      const authCode = query.spapi_oauth_code || query.code;
      const state = query.state;
      const sellingPartnerId = query.selling_partner_id;

      if (!authCode || !state || !sellingPartnerId) {
        const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=0&error=missing_parameters`;
        return reply.code(302).redirect(redirectUrl);
      }

      try {
        // Resolve state → (tenantId, connectionId) from OAuthState
        const oauthStateResult = await prisma.$queryRaw<Array<{id: string; tenantId: string; connectionId: string | null; returnTo: string | null; expiresAt: Date; usedAt: Date | null}>>`
          SELECT id, "tenantId", "connectionId", "returnTo", "expiresAt", "usedAt"
          FROM "OAuthState"
          WHERE "marketplaceType" = ${MarketplaceType.AMAZON}::"MarketplaceType"
          AND state = ${state}
          LIMIT 1`;
        const oauthState = oauthStateResult[0] || null;

        // Hard fails - redirect to UI with error
        if (!oauthState) {
          const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=0&error=invalid_state`;
          return reply.code(302).redirect(redirectUrl);
        }

        if (oauthState.expiresAt < new Date()) {
          const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=0&error=expired_state`;
          return reply.code(302).redirect(redirectUrl);
        }

        if (oauthState.usedAt) {
          const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=0&error=state_already_used`;
          return reply.code(302).redirect(redirectUrl);
        }

        // Validate connectionId is present
        if (!oauthState.connectionId) {
          const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=0&error=missing_connection_id`;
          return reply.code(302).redirect(redirectUrl);
        }

        // Complete OAuth flow with tenantId + connectionId from OAuthState
        await completeAmazonOAuth({
          tenantId: oauthState.tenantId,
          connectionId: oauthState.connectionId,
          code: authCode,
          state,
          sellingPartnerId: sellingPartnerId || "",
        });

        // Mark state as used
        await prisma.$executeRaw`
          UPDATE "OAuthState"
          SET "usedAt" = NOW(), used = TRUE
          WHERE id = ${oauthState.id}
        `;

        // Success: redirect to admin UI callback page
        const returnTo = oauthState.returnTo || "/inbound-email";
        const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=1&tenantId=${encodeURIComponent(oauthState.tenantId)}&marketplaceConnectionId=${encodeURIComponent(oauthState.connectionId)}&sellingPartnerId=${encodeURIComponent(sellingPartnerId || "")}&returnTo=${encodeURIComponent(returnTo)}`;
        return reply.code(302).redirect(redirectUrl);
      } catch (error) {
        console.error("[Amazon OAuth] Callback error:", error);
        const redirectUrl: string = `${redirectBase}/inbound-email/amazon/callback?success=0&error=oauth_failed`;
        return reply.code(302).redirect(redirectUrl);
      }
    }
  );
}

