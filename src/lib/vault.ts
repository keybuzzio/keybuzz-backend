/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-explicit-any */
// src/lib/vault.ts
import { execSync } from "child_process";

const VAULT_ADDR = process.env.VAULT_ADDR || "http://10.0.0.251:8200";
const VAULT_TOKEN_FILE = "/vault/secrets/vault-token";

/**
 * Get a secret from Vault KV v2
 * @param path Path in Vault (e.g., "smtp/user" → secret/data/keybuzz/smtp)
 */
export async function getVaultSecret(path: string): Promise<string> {
  try {
    // Read token from file (injected by Vault Agent or ESO)
    let token = process.env.VAULT_TOKEN;
    
    if (!token) {
      try {
        token = execSync(`cat ${VAULT_TOKEN_FILE}`, { encoding: "utf-8" }).trim();
      } catch {
        throw new Error("Vault token not found");
      }
    }

    // Normalize path for KV v2
    const fullPath = `secret/data/keybuzz/${path}`;

    // Call Vault API
    const response = await fetch(`${VAULT_ADDR}/v1/${fullPath}`, {
      headers: {
        "X-Vault-Token": token,
      },
    });

    if (!response.ok) {
      throw new Error(`Vault error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // KV v2 format: data.data.{key}
    // Assume the secret key is the last part of the path
    const secretKey = path.split("/").pop() || "value";
    const value = data.data?.data?.[secretKey];

    if (!value) {
      throw new Error(`Secret key "${secretKey}" not found in Vault path "${path}"`);
    }

    return value;
  } catch (error: any) {
    console.error(`[Vault] Failed to get secret "${path}":`, error.message);
    throw error;
  }
}

/**
 * Check if Vault is available
 */
export async function isVaultAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${VAULT_ADDR}/v1/sys/health`, {
      method: "GET",
    });
    return response.ok || response.status === 429; // 429 = sealed but running
  } catch {
    return false;
  }
}

