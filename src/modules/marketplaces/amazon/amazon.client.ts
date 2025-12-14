// src/modules/marketplaces/amazon/amazon.client.ts

import type {
  AmazonInboundMessage,
  AmazonFetchResult,
  AmazonFetchParams,
} from "./amazon.types";
import { fetchBuyerMessages } from "./amazon.spapi";
import { getAmazonTenantCredentials } from "./amazon.vault";

/**
 * Interface client Amazon SP-API
 */
export interface AmazonClient {
  fetchInboundMessages(params: AmazonFetchParams): Promise<AmazonFetchResult>;
}

/**
 * Implémentation MOCK pour PH11-06A (dev only)
 * TODO PH11-06B: Remplacer par vraie implémentation SP-API
 */
export class AmazonClientMock implements AmazonClient {
  async fetchInboundMessages(
    params: AmazonFetchParams
  ): Promise<AmazonFetchResult> {
    // Simulate API delay
    // eslint-disable-next-line no-undef
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Mock messages réalistes multi-langues
    const mockMessages: AmazonInboundMessage[] = [
      {
        externalId: "amzn-msg-001",
        threadId: "thread-001",
        orderId: "123-4567890-1234567",
        buyerName: "Jean Dupont",
        buyerEmail: "jean.dupont@example.com",
        language: "fr",
        receivedAt: new Date(Date.now() - 3600000).toISOString(),
        subject: "Où est ma commande ?",
        body: "Bonjour, je n'ai toujours pas reçu ma commande passée il y a 5 jours. Pouvez-vous me donner un statut de livraison ?",
        raw: {
          source: "mock",
          timestamp: new Date().toISOString(),
        },
      },
      {
        externalId: "amzn-msg-002",
        threadId: "thread-002",
        orderId: "123-9876543-7654321",
        buyerName: "Maria García",
        buyerEmail: "maria.garcia@example.es",
        language: "es",
        receivedAt: new Date(Date.now() - 7200000).toISOString(),
        subject: "Producto defectuoso",
        body: "El producto que recibí está defectuoso. Quiero un reembolso inmediato o voy a abrir un caso A-to-Z.",
        raw: {
          source: "mock",
          timestamp: new Date().toISOString(),
        },
      },
      {
        externalId: "amzn-msg-003",
        threadId: "thread-003",
        orderId: "123-1111111-9999999",
        buyerName: "John Smith",
        buyerEmail: "john.smith@example.com",
        language: "en",
        receivedAt: new Date(Date.now() - 10800000).toISOString(),
        subject: "Wrong item received",
        body: "I ordered a blue shirt size M but received a red shirt size L. Please send the correct item ASAP.",
        raw: {
          source: "mock",
          timestamp: new Date().toISOString(),
        },
      },
    ];

    // Si cursor fourni, retourner vide (simulation)
    if (params.cursor) {
      return {
        messages: [],
        nextCursor: undefined,
      };
    }

    // Filtrer par date si fourni
    let filteredMessages = mockMessages;
    if (params.since) {
      filteredMessages = mockMessages.filter(
        (msg) => new Date(msg.receivedAt) > params.since!
      );
    }

    return {
      messages: filteredMessages,
      nextCursor: filteredMessages.length > 0 ? "mock-cursor-next" : undefined,
    };
  }
}

/**
 * Real Amazon SP-API client (PH11-06B)
 */
export class AmazonClientReal implements AmazonClient {
  constructor(
    private tenantId: string,
    private refreshToken: string,
    private roleArn: string,
    private region: string,
    private marketplaceId: string
  ) {}

  async fetchInboundMessages(
    params: AmazonFetchParams
  ): Promise<AmazonFetchResult> {
    try {
      const messages = await fetchBuyerMessages({
        refreshToken: this.refreshToken,
        roleArn: this.roleArn,
        region: this.region,
        marketplaceId: this.marketplaceId,
        since: params.since,
      });

      return {
        messages,
        nextCursor: undefined, // SP-API pagination will be added later
      };
    } catch (error) {
      console.error(
        `[Amazon Client Real] Error fetching messages for tenant ${this.tenantId}:`,
        error
      );
      throw error;
    }
  }
}

/**
 * Factory pour créer le bon client selon l'environnement et credentials
 */
export async function createAmazonClient(
  tenantId: string,
  useMock = false
): Promise<AmazonClient> {
  if (useMock) {
    return new AmazonClientMock();
  }

  // Get tenant credentials from Vault
  const credentials = await getAmazonTenantCredentials(tenantId);

  if (!credentials) {
    console.warn(
      `[Amazon Client] No credentials found for tenant ${tenantId}, using mock`
    );
    return new AmazonClientMock();
  }

  // Get app credentials to get role_arn and region
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;

  if (!vaultAddr || !vaultToken) {
    console.warn("[Amazon Client] Vault not configured, using mock");
    return new AmazonClientMock();
  }

  // Fetch app config from Vault to get role_arn
   
  const appSource = process.env.AMAZON_SPAPI_APP_SOURCE || "external_test";
  const vaultPath =
    appSource === "keybuzz"
      ? "secret/data/keybuzz/ai/amazon_spapi_app"
      : "secret/data/keybuzz/ai/amazon_spapi_app_temp";

  // eslint-disable-next-line no-undef
  const response = await fetch(`${vaultAddr}/v1/${vaultPath}`, {
    headers: { "X-Vault-Token": vaultToken },
  });

  if (!response.ok) {
    console.warn(
      `[Amazon Client] Failed to fetch app config from Vault, using mock`
    );
    return new AmazonClientMock();
  }

  const appData = await response.json();
  const roleArn = appData.data.data.role_arn;

  return new AmazonClientReal(
    tenantId,
    credentials.refresh_token,
    roleArn,
    credentials.region,
    credentials.marketplace_id
  );
}

