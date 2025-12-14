// src/modules/marketplaces/amazon/amazon.vault.ts

import { env } from "../../../config/env";

export interface AmazonTenantCredentials {
  refresh_token: string;
  seller_id: string;
  marketplace_id: string;
  region: string;
  created_at: string;
}

export interface AmazonAppCredentials {
  client_id: string;
  client_secret: string;
}

/**
 * Get Amazon app credentials from Vault (global)
 */
export async function getAmazonAppCredentials(): Promise<AmazonAppCredentials> {
  const vaultAddr = env.VAULT_ADDR || process.env.VAULT_ADDR;
  const vaultToken = env.VAULT_TOKEN || process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    // Fallback to env vars for dev
    return {
      client_id: env.AMAZON_SPAPI_CLIENT_ID || "",
      client_secret: env.AMAZON_SPAPI_CLIENT_SECRET || "",
    };
  }

  try {
    // Determine app source (external_test or keybuzz)
    const appSource = process.env.AMAZON_SPAPI_APP_SOURCE || "external_test";
    const vaultPath =
      appSource === "keybuzz"
        ? "secret/data/keybuzz/ai/amazon_spapi_app"
        : "secret/data/keybuzz/ai/amazon_spapi_app_temp";

    // eslint-disable-next-line no-undef
    const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
      headers: {
        "X-Vault-Token": vaultToken,
      },
    });

    if (!response.ok) {
      console.error(
        `[Amazon Vault] Failed to fetch app credentials from Vault: ${response.status}`
      );
      // Fallback to env
      return {
        client_id: env.AMAZON_SPAPI_CLIENT_ID || "",
        client_secret: env.AMAZON_SPAPI_CLIENT_SECRET || "",
      };
    }

    const data = await response.json();
    return {
      client_id: data.data.data.client_id,
      client_secret: data.data.data.client_secret,
    };
  } catch (error) {
    console.error("[Amazon Vault] Error fetching app credentials:", error);
    // Fallback to env
    return {
      client_id: env.AMAZON_SPAPI_CLIENT_ID || "",
      client_secret: env.AMAZON_SPAPI_CLIENT_SECRET || "",
    };
  }
}

/**
 * Get Amazon tenant credentials from Vault
 */
export async function getAmazonTenantCredentials(
  tenantId: string
): Promise<AmazonTenantCredentials | null> {
  const vaultAddr = env.VAULT_ADDR || process.env.VAULT_ADDR;
  const vaultToken = env.VAULT_TOKEN || process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    console.warn(
      `[Amazon Vault] Vault not configured for tenant ${tenantId}`
    );
    return null;
  }

  try {
    const vaultPath = `secret/data/keybuzz/tenants/${tenantId}/amazon`;
    // eslint-disable-next-line no-undef
    const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
      headers: {
        "X-Vault-Token": vaultToken,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        // No credentials stored yet
        return null;
      }
      console.error(
        `[Amazon Vault] Failed to fetch tenant credentials: ${response.status}`
      );
      return null;
    }

    const data = await response.json();
    return {
      refresh_token: data.data.data.refresh_token,
      seller_id: data.data.data.seller_id,
      marketplace_id: data.data.data.marketplace_id,
      region: data.data.data.region,
      created_at: data.data.data.created_at,
    };
  } catch (error) {
    console.error(
      `[Amazon Vault] Error fetching tenant credentials:`,
      error
    );
    return null;
  }
}

/**
 * Store Amazon tenant credentials in Vault
 */
export async function storeAmazonTenantCredentials(
  tenantId: string,
  credentials: AmazonTenantCredentials
): Promise<void> {
  const vaultAddr = env.VAULT_ADDR || process.env.VAULT_ADDR;
  const vaultToken = env.VAULT_TOKEN || process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    console.warn(
      `[Amazon Vault] Vault not configured, skipping storage for tenant ${tenantId}`
    );
    return;
  }

  try {
    const vaultPath = `secret/data/keybuzz/tenants/${tenantId}/amazon`;
    // eslint-disable-next-line no-undef
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
      console.error(
        `[Amazon Vault] Failed to store credentials: ${response.status} - ${errorText}`
      );
      throw new Error(`Vault write failed: ${response.status}`);
    }

    console.log(
      `[Amazon Vault] Credentials stored successfully for tenant ${tenantId}`
    );
  } catch (error) {
    console.error(
      `[Amazon Vault] Error storing tenant credentials:`,
      error
    );
    throw error;
  }
}

