// src/modules/marketplaces/amazon/amazon.client.ts

import type {
  AmazonInboundMessage,
  AmazonFetchResult,
  AmazonFetchParams,
} from "./amazon.types";

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
 * Factory pour créer le bon client selon l'environnement
 * TODO PH11-06B: Ajouter AmazonClientReal
 */
export function createAmazonClient(): AmazonClient {
  // Pour PH11-06A, toujours retourner le mock
  return new AmazonClientMock();
}

