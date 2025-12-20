// src/modules/marketplaces/amazon/amazon.client.ts

import type {
  AmazonInboundMessage,
  AmazonFetchResult,
  AmazonFetchParams,
} from "./amazon.types";
import { getAmazonTenantCredentials } from "./amazon.vault";

export interface AmazonClient {
  fetchInboundMessages(params: AmazonFetchParams): Promise<AmazonFetchResult>;
}

export class AmazonClientMock implements AmazonClient {
  async fetchInboundMessages(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params: AmazonFetchParams
  ): Promise<AmazonFetchResult> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const mockMessages: AmazonInboundMessage[] = [
      {
        externalId: `mock-${Date.now()}-1`,
        threadId: "thread-123",
        orderId: "408-1234567-8901234",
        buyerName: "John Doe",
        buyerEmail: "encrypted@marketplace.amazon.fr",
        language: "fr",
        subject: "Question concernant ma commande",
        body: "Bonjour, je souhaite savoir quand ma commande sera livrée. Merci.",
        receivedAt: new Date().toISOString(),
        raw: {},
      },
    ];

    return {
      messages: mockMessages,
      nextCursor: undefined,
    };
  }
}

export class AmazonClientReal implements AmazonClient {
  constructor(
    private tenantId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private _region: string = "eu-west-1"
  ) {}

  async fetchInboundMessages(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _params: AmazonFetchParams
  ): Promise<AmazonFetchResult> {
    console.log(`[AmazonClient] Fetching messages for tenant ${this.tenantId}`);
    
    return {
      messages: [],
      nextCursor: undefined,
    };
  }
}

export async function createAmazonClient(tenantId: string): Promise<AmazonClient> {
  const isMock = process.env.AMAZON_SPAPI_MOCK === "true" || process.env.AMAZON_USE_MOCK === "true";
  
  if (isMock) {
    return new AmazonClientMock();
  }

  const creds = await getAmazonTenantCredentials(tenantId);
  if (!creds) {
    console.warn(`[AmazonClient] No credentials for ${tenantId}, using mock`);
    return new AmazonClientMock();
  }

  return new AmazonClientReal(tenantId, creds.region);
}

export async function fetchBuyerMessages(tenantId: string): Promise<AmazonInboundMessage[]> {
  const client = await createAmazonClient(tenantId);
  const result = await client.fetchInboundMessages({});
  return result.messages;
}
