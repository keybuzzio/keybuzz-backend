// src/modules/marketplaces/amazon/amazon.spapi.ts
// PH11-06B.9: Amazon SP-API Buyer Communications client

import { createHash, createHmac } from "crypto";
import { getAccessToken } from "./amazon.tokens";
import { getAmazonTenantCredentials } from "./amazon.vault";
import type { AmazonInboundMessage } from "./amazon.types";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

/**
 * Send buyer message via SP-API Messaging API
 * https://developer-docs.amazon.com/sp-api/docs/messaging-api-v1-reference
 */
export async function sendBuyerMessage(params: {
  tenantId: string;
  orderId: string;
  message: string;
  subject?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { tenantId, orderId, message, subject } = params;

  console.log(`[SP-API] Sending buyer message for order ${orderId}`);

  // 1. Get tenant credentials from Vault
  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds || !creds.refresh_token) {
    throw new Error("Amazon OAuth not connected - no refresh token");
  }

  // 2. Get access token
  const accessToken = await getAccessToken(creds.refresh_token);

  // 3. Build SP-API request
  const region = creds.region || "eu-west-1";
  const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];
  const marketplaceId = creds.marketplace_id || "A13V1IB3VIYZZH"; // Amazon.fr

  // SP-API Messaging endpoint (createConfirmCustomizationDetails or sendInvoice etc.)
  // Using "confirmCustomizationDetails" which allows free-form messaging for certain cases
  // Or we can use "createNegativeFeedbackRemoval" or "sendInvoice" depending on use case
  
  // For buyer messaging, the most appropriate is:
  // POST /messaging/v1/orders/{amazonOrderId}/messages/confirmCustomizationDetails
  // But this requires specific permissions and order context
  
  // Alternative: Use Seller Central API proxy (not SP-API) if messaging not available
  // For now, we implement with proper error handling

  const path = `/messaging/v1/orders/${orderId}/messages`;
  const url = `${endpoint}${path}`;

  const requestBody = {
    text: message,
    marketplaceIds: [marketplaceId],
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-amz-access-token": accessToken,
        "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();
    console.log(`[SP-API] Response ${response.status}: ${responseText.substring(0, 200)}`);

    if (!response.ok) {
      // Parse error
      let errorDetails = responseText;
      try {
        const errorJson = JSON.parse(responseText);
        errorDetails = errorJson.errors?.[0]?.message || errorJson.message || responseText;
      } catch {}

      // Check for specific errors
      if (response.status === 403) {
        throw new Error(`SP-API Forbidden: Messaging scope not authorized. ${errorDetails}`);
      }
      if (response.status === 404) {
        throw new Error(`SP-API: Order ${orderId} not found or messaging not available. ${errorDetails}`);
      }
      if (response.status === 429) {
        throw new Error(`SP-API Rate limit exceeded. Retry later.`);
      }

      throw new Error(`SP-API Error ${response.status}: ${errorDetails}`);
    }

    // Parse success response
    let messageId: string | undefined;
    try {
      const data = JSON.parse(responseText);
      messageId = data.messageId || data.confirmationId || data.id;
    } catch {}

    return {
      success: true,
      messageId,
    };

  } catch (error) {
    console.error(`[SP-API] sendBuyerMessage failed:`, error);
    throw error;
  }
}

/**
 * Check if tenant has messaging capability
 */
export async function checkMessagingCapability(tenantId: string): Promise<{
  available: boolean;
  reason?: string;
}> {
  try {
    const creds = await getAmazonTenantCredentials(tenantId);
    if (!creds || !creds.refresh_token) {
      return { available: false, reason: "oauth_not_connected" };
    }

    // Try to get access token (validates refresh token)
    await getAccessToken(creds.refresh_token);

    // TODO: Call SP-API getMessagingActionsForOrder to check actual capabilities
    // For now, assume connected = can try to send

    return { available: true };

  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes("Failed to refresh")) {
      return { available: false, reason: "token_refresh_failed" };
    }
    return { available: false, reason: msg };
  }
}

// Export types
export type { AmazonInboundMessage };
