// src/modules/marketplaces/amazon/amazon.tokens.ts

import { getAmazonAppCredentials } from "./amazon.vault";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// Cache d'access tokens en mémoire (évite de refresh à chaque appel)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get access token from refresh token (with caching)
 */
export async function getAccessToken(refreshToken: string): Promise<string> {
  // Check cache
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Get app credentials
  const appCreds = await getAmazonAppCredentials();

  if (!appCreds.client_id || !appCreds.client_secret) {
    throw new Error("Amazon SP-API credentials not configured");
  }

  // Exchange refresh token for access token
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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
      `[Amazon Tokens] Token refresh failed: ${response.status} - ${errorText}`
    );
    throw new Error(`Failed to refresh access token: ${response.status}`);
  }

  const data = await response.json();

  // Cache token (expires in 3600s, we cache for 3300s to be safe)
  const expiresAt = Date.now() + 3300 * 1000;
  tokenCache.set(refreshToken, {
    token: data.access_token,
    expiresAt,
  });

  return data.access_token;
}

/**
 * Clear token cache (for testing or forced refresh)
 */
export function clearTokenCache(): void {
  tokenCache.clear();
}

