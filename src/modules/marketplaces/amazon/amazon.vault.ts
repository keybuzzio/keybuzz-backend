// src/modules/marketplaces/amazon/amazon.vault.ts

import { env } from "../../../config/env";

export interface AmazonTenantCredentials {
  refresh_token: string;
  seller_id?: string;
  marketplace_id?: string;
  region?: string;
  created_at?: string;
}

export interface AmazonAppCredentials {
  client_id: string;
  client_secret: string;
  application_id: string;
  redirect_uri: string;
  login_uri: string;
  region: string;
}

/**
 * Get Amazon app credentials from Vault (global KeyBuzz)
 * Path: secret/keybuzz/amazon_spapi/app
 */
export async function getAmazonAppCredentials(): Promise<AmazonAppCredentials> {
  const vaultAddr = env.VAULT_ADDR || process.env.VAULT_ADDR;
  const vaultToken = env.VAULT_TOKEN || process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    console.warn("[Amazon Vault] Vault not configured, falling back to env vars");
    return {
      client_id: env.AMAZON_SPAPI_CLIENT_ID || process.env.AMAZON_SPAPI_CLIENT_ID || "",
      client_secret: env.AMAZON_SPAPI_CLIENT_SECRET || process.env.AMAZON_SPAPI_CLIENT_SECRET || "",
      application_id: process.env.AMAZON_SPAPI_APP_ID || "",
      redirect_uri: env.AMAZON_SPAPI_REDIRECT_URI || process.env.AMAZON_SPAPI_REDIRECT_URI || "",
      login_uri: process.env.AMAZON_SPAPI_LOGIN_URI || "",
      region: process.env.AMAZON_SPAPI_REGION || "eu-west-1",
    };
  }

  try {
    // Path for KeyBuzz app credentials
    const vaultPath = "secret/data/keybuzz/amazon_spapi/app";

    const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
      headers: {
        "X-Vault-Token": vaultToken,
      },
    });

    if (!response.ok) {
      console.error(`[Amazon Vault] Failed to fetch app credentials: ${response.status}`);
      throw new Error(`Vault fetch failed: ${response.status}`);
    }

    const data = await response.json();
    const creds = data.data.data;

    console.log("[Amazon Vault] Successfully loaded KeyBuzz app credentials");

    return {
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      application_id: creds.application_id,
      redirect_uri: creds.redirect_uri,
      login_uri: creds.login_uri,
      region: creds.region || "eu-west-1",
    };
  } catch (error) {
    console.error("[Amazon Vault] Error fetching app credentials:", error);
    throw error;
  }
}

/**
 * Get Amazon tenant credentials from Vault
 * Path: secret/keybuzz/tenants/{tenantId}/amazon_spapi
 */
export async function getAmazonTenantCredentials(
  tenantId: string
): Promise<AmazonTenantCredentials | null> {
  const vaultAddr = env.VAULT_ADDR || process.env.VAULT_ADDR;
  const vaultToken = env.VAULT_TOKEN || process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    console.warn(`[Amazon Vault] Vault not configured for tenant ${tenantId}`);
    return null;
  }

  try {
    const vaultPath = `secret/data/keybuzz/tenants/${tenantId}/amazon_spapi`;
    const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
      headers: {
        "X-Vault-Token": vaultToken,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      console.error(`[Amazon Vault] Failed to fetch tenant credentials: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.data.data as AmazonTenantCredentials;
  } catch (error) {
    console.error(`[Amazon Vault] Error fetching tenant credentials:`, error);
    return null;
  }
}

/**
 * Store Amazon tenant credentials in Vault
 * Path: secret/keybuzz/tenants/{tenantId}/amazon_spapi
 */
export async function storeAmazonTenantCredentials(
  tenantId: string,
  credentials: AmazonTenantCredentials
): Promise<void> {
  const vaultAddr = env.VAULT_ADDR || process.env.VAULT_ADDR;
  const vaultToken = env.VAULT_TOKEN || process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    console.warn(`[Amazon Vault] Vault not configured, skipping storage for tenant ${tenantId}`);
    return;
  }

  try {
    const vaultPath = `secret/data/keybuzz/tenants/${tenantId}/amazon_spapi`;
    const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
      method: "POST",
      headers: {
        "X-Vault-Token": vaultToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: credentials }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Amazon Vault] Failed to store credentials: ${response.status} - ${errorText}`);
      throw new Error(`Vault write failed: ${response.status}`);
    }

    console.log(`[Amazon Vault] Credentials stored for tenant ${tenantId}`);
  } catch (error) {
    console.error(`[Amazon Vault] Error storing tenant credentials:`, error);
    throw error;
  }
}