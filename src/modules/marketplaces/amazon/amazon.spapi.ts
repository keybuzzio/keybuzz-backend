// src/modules/marketplaces/amazon/amazon.spapi.ts
// Amazon SP-API Buyer Communications client

import { createHash, createHmac } from "crypto";
import { getAccessToken } from "./amazon.tokens";
import type { AmazonInboundMessage } from "./amazon.types";

/**
 * SP-API endpoints by region
 * TODO PH11-06B.2: Use for real API calls
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SPAPI_ENDPOINTS: Record<string, string> = {
  "eu-west-1": "https://sellingpartnerapi-eu.amazon.com",
  "us-east-1": "https://sellingpartnerapi-na.amazon.com",
  "us-west-2": "https://sellingpartnerapi-fe.amazon.com",
};

/**
 * AWS SigV4 signature generation
 * TODO PH11-06B.2: Use for authenticated SP-API calls
 */
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

  // Canonical request
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

  // String to sign
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

  // Signing key
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

  // Authorization header
  return `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * Call Amazon SP-API with AWS SigV4 authentication
 * TODO PH11-06B.2: Implement full AWS SigV4 signing
 */
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

  // For now, simplified without full AWS SigV4 (requires AWS SDK or manual implementation)
  // TODO: Add full AWS SigV4 signature for production
  // eslint-disable-next-line no-undef
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

/**
 * Fetch buyer messages from SP-API
 */
export async function fetchBuyerMessages(params: {
  refreshToken: string;
  roleArn: string;
  region: string;
  marketplaceId: string;
  since?: Date;
}): Promise<AmazonInboundMessage[]> {
  const { refreshToken, marketplaceId, since } = params;

  // Get access token (cached)
  await getAccessToken(refreshToken);

  // TODO PH11-06B.2: Use SP-API endpoint for real API calls
  // const endpoint = SPAPI_ENDPOINTS[region] || SPAPI_ENDPOINTS["eu-west-1"];

  // Build query params
  const queryParams: Record<string, string> = {
    marketplaceIds: marketplaceId,
  };

  if (since) {
    queryParams.createdAfter = since.toISOString();
  }

  // Call SP-API Messaging API
  // Endpoint: /messaging/v1/orders/{orderId}/messages
  // For initial implementation, we'll use a simplified approach
  
  // TODO PH11-06B.2: Implement proper SP-API Buyer Communications endpoint
  // For now, return empty array (structure is ready)
  console.log(
    `[Amazon SP-API] Would fetch messages with params:`,
    queryParams
  );

  // Placeholder: return empty array until full SP-API integration
  // The structure is ready for real implementation
  return [];
}

/**
 * Normalize SP-API message to AmazonInboundMessage
 * TODO PH11-06B.2: Use for real SP-API message mapping
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normalizeSpApiMessage(rawMessage: {
  messageId: string;
  locale?: string;
  text: string;
  createdDate: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}): AmazonInboundMessage {
  return {
    externalId: rawMessage.messageId,
    threadId: rawMessage.messageId, // SP-API doesn't have explicit threadId
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

