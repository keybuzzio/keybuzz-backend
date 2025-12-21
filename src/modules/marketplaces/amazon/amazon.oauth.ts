// src/modules/marketplaces/amazon/amazon.oauth.ts
// PH11-AMZ-OAUTH-TENANT-FIX-01: Use OAuthState table for tenant/connection tracking

import { randomUUID } from "crypto";
import { prisma } from "../../../lib/db";
import { getAmazonAppCredentials, storeAmazonTenantCredentials } from "./amazon.vault";
import { MarketplaceType } from "@prisma/client";

/**
 * Amazon LWA (Login with Amazon) OAuth URLs
 */
const LWA_AUTHORIZE_URL = "https://sellercentral.amazon.com/apps/authorize/consent";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

/**
 * Generate Amazon OAuth consent URL with tenant/connection tracking
 * @param tenantId - Tenant ID
 * @param connectionId - MarketplaceConnection ID
 */
export async function generateAmazonOAuthUrl(
  tenantId: string,
  connectionId: string
): Promise<{
  authUrl: string;
  state: string;
  expiresAt: Date;
}> {
  // Get app credentials from Vault
  const appCreds = await getAmazonAppCredentials();

  if (!appCreds.application_id) {
    throw new Error("Amazon SP-API application_id not configured in Vault");
  }

  // Verify connection exists and belongs to tenant
  const connection = await prisma.marketplaceConnection.findFirst({
    where: {
      id: connectionId,
      tenantId,
      type: MarketplaceType.AMAZON,
    },
  });

  if (!connection) {
    throw new Error("Connection not found or does not belong to tenant");
  }

  // Generate secure state (anti-CSRF)
  const state = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Store state in OAuthState table with tenantId/connectionId binding
  await prisma.$executeRaw`
    INSERT INTO "OAuthState" ("id", "marketplaceType", "state", "tenantId", "connectionId", "expiresAt", "used", "createdAt")
    VALUES (${randomUUID()}, ${MarketplaceType.AMAZON}::"MarketplaceType", ${state}, ${tenantId}, ${connectionId}, ${expiresAt}, false, NOW())
  `;

  console.log(`[Amazon OAuth] Created OAuth state for tenant ${tenantId}, connectionId: ${connectionId}`);

  // Build Amazon consent URL with application_id
  const params_url = new URLSearchParams({
    application_id: appCreds.application_id,
    state,
    version: "beta",
  });

  // Add redirect_uri if configured
  if (appCreds.redirect_uri) {
    params_url.set("redirect_uri", appCreds.redirect_uri);
  }

  const authUrl = `${LWA_AUTHORIZE_URL}?${params_url.toString()}`;

  console.log(`[Amazon OAuth] Generated auth URL for tenant ${tenantId}, app_id: ${appCreds.application_id.substring(0, 30)}...`);

  return {
    authUrl,
    state,
    expiresAt,
  };
}

/**
 * Validate OAuth state and retrieve tenantId/connectionId
 */
export async function validateOAuthState(
  state: string
): Promise<{ tenantId: string; connectionId: string | null } | null> {
  const oauthStateResult = await prisma.$queryRaw<Array<{
    id: string;
    tenantId: string;
    connectionId: string | null;
    expiresAt: Date;
    used: boolean;
  }>>`
    SELECT "id", "tenantId", "connectionId", "expiresAt", "used"
    FROM "OAuthState"
    WHERE "state" = ${state}
    LIMIT 1
  `;

  const oauthState = oauthStateResult[0] || null;

  if (!oauthState) {
    console.warn(`[Amazon OAuth] State not found: ${state.substring(0, 8)}...`);
    return null;
  }

  if (oauthState.used) {
    console.warn(`[Amazon OAuth] State already used: ${state.substring(0, 8)}...`);
    return null;
  }

  if (oauthState.expiresAt < new Date()) {
    console.warn(`[Amazon OAuth] State expired: ${state.substring(0, 8)}...`);
    return null;
  }

  return {
    tenantId: oauthState.tenantId,
    connectionId: oauthState.connectionId,
  };
}

/**
 * Mark OAuth state as used
 */
export async function markOAuthStateAsUsed(state: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "OAuthState"
    SET "used" = true, "usedAt" = NOW()
    WHERE "state" = ${state}
  `;
}

/**
 * Exchange authorization code for refresh token (LWA)
 */
export async function exchangeCodeForTokens(code: string): Promise<{
  refresh_token: string;
  access_token: string;
}> {
  const appCreds = await getAmazonAppCredentials();

  if (!appCreds.client_id || !appCreds.client_secret) {
    throw new Error("Amazon SP-API client credentials not configured in Vault");
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: appCreds.client_id,
    client_secret: appCreds.client_secret,
  });

  const response = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Amazon OAuth] Token exchange failed: ${response.status} - ${errorText}`);
    throw new Error(`Amazon token exchange failed: ${response.status}`);
  }

  const data = await response.json();
  console.log("[Amazon OAuth] Token exchange successful");

  return {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
  };
}

/**
 * Input type for completeAmazonOAuth
 */
export type CompleteAmazonOAuthInput = {
  tenantId: string;
  connectionId: string;
  code: string;
  state: string;
  sellingPartnerId: string;
};

/**
 * Complete OAuth flow: validate, exchange, store, update specific connection
 */
export async function completeAmazonOAuth(input: CompleteAmazonOAuthInput): Promise<void> {
  const { tenantId, connectionId, code, state, sellingPartnerId } = input;

  // 1. Verify connection exists and belongs to tenant (security check)
  const connection = await prisma.marketplaceConnection.findFirst({
    where: {
      id: connectionId,
      tenantId,
      type: MarketplaceType.AMAZON,
    },
  });

  if (!connection) {
    throw new Error("Connection not found or does not belong to tenant");
  }

  // 2. Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code);

  // 3. Store in Vault (tenant-scoped)
  await storeAmazonTenantCredentials(tenantId, {
    refresh_token: tokens.refresh_token,
    seller_id: sellingPartnerId,
    marketplace_id: "A13V1IB3VIYZZH", // Amazon.fr (EU)
    region: "eu-west-1",
    created_at: new Date().toISOString(),
  });

  // 4. Update ONLY the specific MarketplaceConnection (not updateMany)
  const vaultPath = `secret/keybuzz/tenants/${tenantId}/amazon_spapi`;

  await prisma.marketplaceConnection.update({
    where: { id: connectionId },
    data: {
      status: "CONNECTED",
      vaultPath,
      displayName: `Amazon Seller ${sellingPartnerId}`,
      region: "EU",
      marketplaceId: "A13V1IB3VIYZZH",
      lastSyncAt: new Date(),
      lastError: null,
    },
  });

  // 5. Mark state as used
  await markOAuthStateAsUsed(state);

  console.log(`[Amazon OAuth] Flow completed for tenant ${tenantId}, connection ${connectionId}, seller: ${sellingPartnerId}`);
}
