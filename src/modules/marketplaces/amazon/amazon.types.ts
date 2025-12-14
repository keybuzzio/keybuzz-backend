// src/modules/marketplaces/amazon/amazon.types.ts

export type AmazonInboundMessage = {
  externalId: string;
  threadId?: string;
  orderId?: string;
  buyerName?: string;
  buyerEmail?: string;
  language?: string;
  receivedAt: string; // ISO
  subject?: string;
  body: string;
  raw: unknown;
};

export type AmazonFetchResult = {
  messages: AmazonInboundMessage[];
  nextCursor?: string;
};

export type AmazonFetchParams = {
  since?: Date;
  cursor?: string;
};

