// src/modules/marketplaces/amazon/amazon.oauth.ts

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
 * Generate Amazon OAuth consent URL
 * Stores state in OAuthState table with tenantId + connectionId binding
 */
export async function generateAmazonOAuthUrl(
  tenantId: string,
  connectionId: string,
  returnTo?: string
): Promise<{
  authUrl: string;
  state: string;
  expiresAt: Date;
}> {
  // Get app credentials from Vault
  const appCreds = await getAmazonAppCredentials();

  if (!appCreds.client_id) {
    throw new Error("Amazon SP-API client_id not configured");
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

  // Store state in OAuthState (source of truth for tenantId + connectionId binding)
  // Use raw SQL to ensure marketplaceType is used (not provider)
  const oauthStateId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "OAuthState" (id, "marketplaceType", state, "tenantId", "connectionId", "returnTo", "expiresAt", "usedAt", "createdAt", "updatedAt")
    VALUES (${oauthStateId}, ${MarketplaceType.AMAZON}::"MarketplaceType", ${state}, ${tenantId}, ${connectionId}, ${returnTo || null}, ${expiresAt}, NULL, NOW(), NOW())
  `;

  // Build Amazon consent URL with redirect_uri
  const redirectUri = appCreds.redirect_uri || "https://platform-api.keybuzz.io/api/v1/marketplaces/amazon/oauth/callback";
  const params = new URLSearchParams({
    application_id: appCreds.application_id || appCreds.client_id,
    state,
    version: "beta",
    redirect_uri: redirectUri,
  });

  const authUrl = `${LWA_AUTHORIZE_URL}?${params.toString()}`;

  return {
    authUrl,
    state,
    expiresAt,
  };
}

/**
 * Validate OAuth state (anti-CSRF)
 */
export async function validateOAuthState(
  tenantId: string,
  state: string
): Promise<boolean> {
  const connection = await prisma.marketplaceConnection.findFirst({
    where: {
      tenantId,
      type: MarketplaceType.AMAZON,
    },
  });

  if (!connection) {
    return false;
  }

  const syncState = await prisma.marketplaceSyncState.findFirst({
    where: {
      tenantId,
      connectionId: connection.id,
      type: MarketplaceType.AMAZON,
    },
  });

  if (!syncState || syncState.cursor !== state) {
    return false;
  }

  // Check if not expired (15 minutes)
  if (
    syncState.lastPolledAt &&
    syncState.lastPolledAt < new Date()
  ) {
    return false;
  }

  return true;
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
    throw new Error("Amazon SP-API credentials not configured");
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: appCreds.client_id,
    client_secret: appCreds.client_secret,
  });

  // eslint-disable-next-line no-undef
  const response = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `[Amazon OAuth] Token exchange failed: ${response.status} - ${errorText}`
    );
    throw new Error(`Amazon token exchange failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    refresh_token: data.refresh_token,
    access_token: data.access_token,
  };
}

/**
 * Complete OAuth flow: validate, exchange, store, update DB
 * Updates ONLY the specific connection (not all connections for tenant)
 */
export async function completeAmazonOAuth(params: {
  tenantId: string;
  connectionId: string;
  code: string;
  state: string;
  sellingPartnerId: string; // From Amazon callback (spapi_oauth_code)
}): Promise<void> {
  const { tenantId, connectionId, code, state, sellingPartnerId } = params;

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

  // 4. Update ONLY this specific connection (not updateMany)
  const vaultPath = `secret/keybuzz/tenants/${tenantId}/amazon_spapi`;

  await prisma.marketplaceConnection.update({
    where: {
      id: connectionId,
    },
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

  console.log(`[Amazon OAuth] OAuth flow completed for tenant ${tenantId}, connection ${connectionId}`);
}

