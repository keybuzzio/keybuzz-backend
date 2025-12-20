// src/modules/marketplaces/amazon/amazon.spapi.ts
// Amazon SP-API Buyer Communications client

import { createHash, createHmac } from "crypto";
import { getAccessToken } from "./amazon.tokens";
import type { AmazonInboundMessage } from "./amazon.types";

const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function generateAwsSignature(params: {
  method: string;
  host: string;
  path: string;
  queryString: string;
  headers: Record<string, string>;
  payload: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}): string {
  const {
    method,
    path,
    queryString,
    headers,
    payload,
    accessKeyId,
    secretAccessKey,
    region,
    service,
  } = params;

  const date = new Date();
  const amzDate = date.toISOString().replace(/[:.-]|\.\d{3}/g, "");
  const dateStamp = amzDate.substring(0, 8);

  const canonicalUri = path;
  const canonicalQueryString = queryString;
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key.toLowerCase()}:${headers[key].trim()}\n`)
    .join("");
  const signedHeaders = Object.keys(headers)
    .sort()
    .map((key) => key.toLowerCase())
    .join(";");

  const payloadHash = createHash("sha256").update(payload).digest("hex");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");

  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`)
    .update(dateStamp)
    .digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService)
    .update("aws4_request")
    .digest();

  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");

  return `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function callSpApi(params: {
  endpoint: string;
  path: string;
  accessToken: string;
  roleArn: string;
  region: string;
  method?: string;
  queryParams?: Record<string, string>;
}): Promise<unknown> {
  const {
    endpoint,
    path,
    accessToken,
    method = "GET",
    queryParams = {},
  } = params;

  const url = new URL(path, endpoint);
  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  const headers: Record<string, string> = {
    Host: url.hostname,
    "x-amz-access-token": accessToken,
    "x-amz-date": new Date().toISOString().replace(/[:.-]|\.\d{3}/g, ""),
    "Content-Type": "application/json",
  };

  const response = await fetch(url.toString(), {
    method,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `[Amazon SP-API] API call failed: ${response.status} - ${errorText}`
    );
    throw new Error(`SP-API call failed: ${response.status}`);
  }

  return response.json();
}

export async function fetchBuyerMessages(params: {
  refreshToken: string;
  roleArn: string;
  region: string;
  marketplaceId: string;
  since?: Date;
}): Promise<AmazonInboundMessage[]> {
  const { refreshToken, marketplaceId, since } = params;

  await getAccessToken(refreshToken);

  const queryParams: Record<string, string> = {
    marketplaceIds: marketplaceId,
  };

  if (since) {
    queryParams.createdAfter = since.toISOString();
  }

  console.log(
    `[Amazon SP-API] Would fetch messages with params:`,
    queryParams
  );

  return [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normalizeSpApiMessage(rawMessage: {
  messageId: string;
  locale?: string;
  text: string;
  createdDate: string;
  [key: string]: unknown;
}): AmazonInboundMessage {
  return {
    externalId: rawMessage.messageId,
    threadId: rawMessage.messageId,
    orderId: undefined,
    buyerName: undefined,
    buyerEmail: undefined,
    language: rawMessage.locale || "en",
    receivedAt: rawMessage.createdDate,
    subject: undefined,
    body: rawMessage.text,
    raw: rawMessage,
  };
}

/**
 * PH11-06B.9 - Send message to buyer via SP-API Messaging
 */
export interface SendBuyerMessageParams {
  tenantId: string;
  amazonOrderId: string;
  message: string;
  marketplaceId?: string;
}

export interface SendBuyerMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendBuyerMessage(
  params: SendBuyerMessageParams
): Promise<SendBuyerMessageResult> {
  const { tenantId, amazonOrderId, message, marketplaceId } = params;
  console.log(`[SP-API] sendBuyerMessage for tenant ${tenantId}, order ${amazonOrderId}`);

  try {
    // Mock mode for testing
    if (process.env.AMAZON_SP_API_MOCK === "true") {
      const mockMessageId = `amzn-mock-${Date.now()}`;
      console.log(`[SP-API] Mock mode: returning success with messageId ${mockMessageId}`);
      return {
        success: true,
        messageId: mockMessageId,
      };
    }

    // Check for credentials (in production, would come from Vault)
    const hasCredentials = process.env.AMAZON_SP_API_ENABLED === "true";
    
    if (!hasCredentials) {
      console.log(`[SP-API] No Amazon credentials for tenant ${tenantId}`);
      return {
        success: false,
        error: "oauth_not_connected",
      };
    }

    // Build SP-API request
    const endpoint = SPAPI_ENDPOINTS["eu-west-1"];
    const path = `/messaging/v1/orders/${encodeURIComponent(amazonOrderId)}/messages`;
    
    const requestBody = {
      text: message,
      marketplaceId: marketplaceId || "A1PA6795UKMFR9",
    };

    console.log(`[SP-API] Would call: POST ${endpoint}${path}`);
    console.log(`[SP-API] Body:`, JSON.stringify(requestBody));

    // TODO: Implement actual SP-API call
    return {
      success: false,
      error: "oauth_not_connected",
    };
  } catch (error) {
    console.error(`[SP-API] Error sending message:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if tenant has messaging capabilities (OAuth connected)
 */
export async function checkMessagingCapabilities(tenantId: string): Promise<{
  canSend: boolean;
  reason?: string;
}> {
  // Check mock mode first
  if (process.env.AMAZON_SP_API_MOCK === "true") {
    return { canSend: true };
  }
  
  // Check if credentials are configured
  const hasCredentials = process.env.AMAZON_SP_API_ENABLED === "true";
  
  if (!hasCredentials) {
    // In dev mode, allow sending (will fail at send time with clear error)
    if (process.env.NODE_ENV !== "production") {
      return { canSend: true };
    }
    return { canSend: false, reason: "oauth_not_connected" };
  }
  
  return { canSend: true };
}
