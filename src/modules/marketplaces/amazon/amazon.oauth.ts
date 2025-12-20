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
 */
export async function generateAmazonOAuthUrl(tenantId: string): Promise<{
  authUrl: string;
  state: string;
  expiresAt: Date;
}> {
  // Get app credentials from Vault
  const appCreds = await getAmazonAppCredentials();

  if (!appCreds.application_id) {
    throw new Error("Amazon SP-API application_id not configured in Vault");
  }

  // Generate secure state (anti-CSRF)
  const state = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  // Store state in MarketplaceSyncState temporarily (anti-CSRF validation)
  const connection = await prisma.marketplaceConnection.findFirst({
    where: {
      tenantId,
      type: MarketplaceType.AMAZON,
    },
  });

  if (connection) {
    // Update or create sync state with OAuth state
    const existingState = await prisma.marketplaceSyncState.findFirst({
      where: {
        tenantId,
        connectionId: connection.id,
        type: MarketplaceType.AMAZON,
      },
    });

    if (existingState) {
      await prisma.marketplaceSyncState.update({
        where: { id: existingState.id },
        data: {
          cursor: state,
          lastPolledAt: expiresAt,
        },
      });
    } else {
      await prisma.marketplaceSyncState.create({
        data: {
          tenantId,
          connectionId: connection.id,
          type: MarketplaceType.AMAZON,
          cursor: state,
          lastPolledAt: expiresAt,
        },
      });
    }
  }

  // Build Amazon consent URL with application_id (NOT client_id)
  const params = new URLSearchParams({
    application_id: appCreds.application_id,
    state,
    version: "beta",
  });

  // Optional: add redirect_uri if configured
  if (appCreds.redirect_uri) {
    params.set("redirect_uri", appCreds.redirect_uri);
  }

  const authUrl = `${LWA_AUTHORIZE_URL}?${params.toString()}`;

  console.log(`[Amazon OAuth] Generated auth URL for tenant ${tenantId}, app_id: ${appCreds.application_id.substring(0, 30)}...`);

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
    console.warn(`[Amazon OAuth] No connection found for tenant ${tenantId}`);
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
    console.warn(`[Amazon OAuth] State mismatch for tenant ${tenantId}`);
    return false;
  }

  // Check if not expired (15 minutes)
  if (syncState.lastPolledAt && syncState.lastPolledAt < new Date()) {
    console.warn(`[Amazon OAuth] State expired for tenant ${tenantId}`);
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
 * Complete OAuth flow: validate, exchange, store, update DB
 */
export async function completeAmazonOAuth(params: {
  tenantId: string;
  code: string;
  state: string;
  sellingPartnerId: string;
}): Promise<void> {
  const { tenantId, code, state, sellingPartnerId } = params;

  // 1. Validate state (anti-CSRF)
  const isValid = await validateOAuthState(tenantId, state);
  if (!isValid) {
    throw new Error("Invalid or expired OAuth state");
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

  // 4. Update MarketplaceConnection
  const vaultPath = `secret/keybuzz/tenants/${tenantId}/amazon_spapi`;

  await prisma.marketplaceConnection.updateMany({
    where: {
      tenantId,
      type: MarketplaceType.AMAZON,
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

  // 5. Clean up state
  await prisma.marketplaceSyncState.updateMany({
    where: {
      tenantId,
      type: MarketplaceType.AMAZON,
    },
    data: {
      cursor: null,
    },
  });

  console.log(`[Amazon OAuth] Flow completed for tenant ${tenantId}, seller: ${sellingPartnerId}`);
}