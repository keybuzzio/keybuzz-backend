// src/modules/marketplaces/amazon/amazon.routes.ts
// PH11-06B.8 - Self-serve Amazon OAuth

import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from "fastify";
import { prisma } from "../../../lib/db";
import { env } from "../../../config/env";
import { ensureAmazonConnection } from "./amazon.service";
import { pollAmazonForTenant } from "./amazon.poller";
import { MarketplaceType } from "@prisma/client";
import { generateAmazonOAuthUrl, completeAmazonOAuth } from "./amazon.oauth";

// Admin UI callback URL
const ADMIN_CALLBACK_SUCCESS_URL = process.env.ADMIN_CALLBACK_URL || "https://admin-dev.keybuzz.io/inbound-email/amazon/callback";

// Type for JWT user (from @fastify/jwt)
interface JwtUserPayload {
  sub?: string;
  tenantId?: string;
  role?: string;
  email?: string;
  iat?: number;
}

/**
 * JWT Authentication preHandler
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    console.error("[Amazon Routes] JWT verification failed:", (err as Error).message);
    return reply.status(401).send({ error: "Unauthorized", details: (err as Error).message });
  }
}

/**
 * Authenticated Amazon routes (requires JWT)
 */
async function amazonAuthenticatedPlugin(server: FastifyInstance, _opts: FastifyPluginOptions) {
  // Apply JWT auth to all routes in this plugin
  server.addHook("preHandler", authenticate);

  /**
   * GET /status
   */
  server.get("/status", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    
    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
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
  });

  /**
   * POST /oauth/start
   */
  server.post("/oauth/start", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    
    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
    }

    try {
      console.log(`[Amazon OAuth] Starting OAuth for tenant: ${user.tenantId}`);

      let connection = await prisma.marketplaceConnection.findFirst({
        where: {
          tenantId: user.tenantId,
          type: MarketplaceType.AMAZON,
        },
      });

      if (!connection) {
        connection = await prisma.marketplaceConnection.create({
          data: {
            tenantId: user.tenantId,
            type: MarketplaceType.AMAZON,
            status: "PENDING",
            displayName: "Amazon",
          },
        });
        console.log(`[Amazon OAuth] Created new connection: ${connection.id}`);
      }

      const oauthData = await generateAmazonOAuthUrl(user.tenantId);

      console.log(`[Amazon OAuth] Generated OAuth URL for tenant ${user.tenantId}`);

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
  });

  /**
   * POST /mock/connect
   */
  server.post("/mock/connect", async (request, reply) => {
    const user = request.user as JwtUserPayload;
    
    if (!user?.tenantId) {
      return reply.status(403).send({ error: "Forbidden: no tenantId" });
    }

    const isDevMode =
      env.NODE_ENV === "development" ||
      process.env.KEYBUZZ_DEV_MODE === "true";

    if (!isDevMode) {
      return reply.status(403).send({
        error: "This endpoint is only available in development mode",
      });
    }

    const connection = await ensureAmazonConnection(user.tenantId);

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
  });
}

/**
 * Register authenticated Amazon routes
 */
export async function registerAmazonRoutes(server: FastifyInstance) {
  await server.register(amazonAuthenticatedPlugin, { prefix: "/api/v1/marketplaces/amazon" });
}

/**
 * Public Amazon OAuth callback route (no JWT required)
 */
export async function registerAmazonOAuthCallbackRoute(server: FastifyInstance) {
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

      console.log("[Amazon OAuth] Received callback:", {
        hasCode: !!query.code,
        hasSpApiCode: !!query.spapi_oauth_code,
        state: query.state?.substring(0, 8) + "...",
        sellingPartnerId: query.selling_partner_id,
        error: query.error,
      });

      if (query.error) {
        console.error(`[Amazon OAuth] Authorization failed: ${query.error} - ${query.error_description}`);
        const errorUrl = new URL(ADMIN_CALLBACK_SUCCESS_URL);
        errorUrl.searchParams.set("success", "false");
        errorUrl.searchParams.set("error", query.error_description || query.error);
        return reply.redirect(errorUrl.toString());
      }

      const authCode = query.spapi_oauth_code || query.code;
      const state = query.state;
      const sellingPartnerId = query.selling_partner_id;

      if (!authCode || !state || !sellingPartnerId) {
        console.error("[Amazon OAuth] Missing parameters");
        const errorUrl = new URL(ADMIN_CALLBACK_SUCCESS_URL);
        errorUrl.searchParams.set("success", "false");
        errorUrl.searchParams.set("error", "Missing required OAuth parameters");
        return reply.redirect(errorUrl.toString());
      }

      try {
        const syncState = await prisma.marketplaceSyncState.findFirst({
          where: {
            cursor: state,
            type: MarketplaceType.AMAZON,
          },
        });

        if (!syncState) {
          console.error("[Amazon OAuth] State not found or expired");
          const errorUrl = new URL(ADMIN_CALLBACK_SUCCESS_URL);
          errorUrl.searchParams.set("success", "false");
          errorUrl.searchParams.set("error", "Invalid or expired OAuth state");
          return reply.redirect(errorUrl.toString());
        }

        console.log(`[Amazon OAuth] Found tenant: ${syncState.tenantId}`);

        await completeAmazonOAuth({
          tenantId: syncState.tenantId,
          code: authCode,
          state,
          sellingPartnerId,
        });

        console.log(`[Amazon OAuth] OAuth completed for tenant ${syncState.tenantId}`);

        const successUrl = new URL(ADMIN_CALLBACK_SUCCESS_URL);
        successUrl.searchParams.set("success", "true");
        successUrl.searchParams.set("tenantId", syncState.tenantId);
        successUrl.searchParams.set("sellingPartnerId", sellingPartnerId);
        return reply.redirect(successUrl.toString());
      } catch (error) {
        console.error("[Amazon OAuth] Callback error:", error);
        const errorUrl = new URL(ADMIN_CALLBACK_SUCCESS_URL);
        errorUrl.searchParams.set("success", "false");
        errorUrl.searchParams.set("error", (error as Error).message);
        return reply.redirect(errorUrl.toString());
      }
    }
  );
}
