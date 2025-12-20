/**
 * PH11-06B.9: Amazon Send Reply Worker
 * Processes AMAZON_SEND_REPLY jobs with rate limiting and idempotence
 */

import { PrismaClient, MarketplaceType, TicketChannel, EventActorType } from "@prisma/client";
import { sendBuyerMessage } from "../modules/marketplaces/amazon/amazon.spapi";
import { createHash } from "crypto";

const prisma = new PrismaClient();

// Rate limit: 1 request per second per tenant
const lastSendTime = new Map<string, number>();
const RATE_LIMIT_MS = 1000;

interface SendReplyPayload {
  ticketId: string;
  connectionId: string;
  message: string;
  externalThreadId?: string;
  orderId?: string;
  to?: string;
}

interface ProcessResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

function computeBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").substring(0, 32);
}

async function enforceRateLimit(tenantId: string): Promise<void> {
  const now = Date.now();
  const lastSend = lastSendTime.get(tenantId) || 0;
  const waitTime = RATE_LIMIT_MS - (now - lastSend);
  
  if (waitTime > 0) {
    console.log(`[AmazonSendReply] Rate limiting tenant ${tenantId}, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastSendTime.set(tenantId, Date.now());
}

export async function processAmazonSendReply(
  jobId: string,
  tenantId: string,
  payload: SendReplyPayload
): Promise<ProcessResult> {
  const { ticketId, connectionId, message, externalThreadId, orderId, to } = payload;

  console.log(`[AmazonSendReply] Processing job ${jobId} for ticket ${ticketId}`);

  const bodyHash = computeBodyHash(message);

  // Check idempotence
  const existing = await prisma.marketplaceOutboundMessage.findFirst({
    where: {
      connectionId,
      ticketId,
      bodyHash,
      status: "SENT",
    },
  });

  if (existing) {
    console.log(`[AmazonSendReply] Already sent (idempotent), skipping`);
    return { success: true, messageId: existing.providerMessageId || undefined };
  }

  // Create/update outbound record
  const outbound = await prisma.marketplaceOutboundMessage.upsert({
    where: {
      connectionId_ticketId_bodyHash: {
        connectionId: connectionId || "",
        ticketId: ticketId || "",
        bodyHash,
      },
    },
    update: {
      attempts: { increment: 1 },
      status: "PENDING",
    },
    create: {
      tenantId,
      connectionId,
      ticketId,
      channel: TicketChannel.AMAZON,
      marketplaceType: MarketplaceType.AMAZON,
      externalThreadId: externalThreadId || null,
      orderId: orderId || null,
      toAddress: to || "buyer",
      body: message,
      bodyHash,
      status: "PENDING",
    },
  });

  await enforceRateLimit(tenantId);

  const connection = await prisma.marketplaceConnection.findFirst({
    where: {
      id: connectionId,
      tenantId,
      type: MarketplaceType.AMAZON,
    },
  });

  if (!connection || connection.status !== "CONNECTED") {
    const error = "Amazon connection not found or not connected";
    await markFailed(outbound.id, ticketId, tenantId, error);
    return { success: false, error };
  }

  try {
    const result = await sendBuyerMessage({
      tenantId,
      orderId: orderId || "",
      message,
    });

    await prisma.marketplaceOutboundMessage.update({
      where: { id: outbound.id },
      data: {
        status: "SENT",
        providerMessageId: result.messageId || null,
        sentAt: new Date(),
        error: null,
      },
    });

    // Use string literal for event type
    await prisma.ticketEvent.create({
      data: {
        ticketId,
        tenantId,
        type: "OUTBOUND_SENT" as any,
        actorType: EventActorType.SYSTEM,
        payload: {
          channel: "AMAZON",
          messageId: result.messageId,
          outboundId: outbound.id,
        },
      },
    });

    console.log(`[AmazonSendReply] ✓ Message sent: ${result.messageId}`);
    return { success: true, messageId: result.messageId };

  } catch (error) {
    const errorMsg = (error as Error).message;
    console.error(`[AmazonSendReply] ✗ Failed:`, errorMsg);
    await markFailed(outbound.id, ticketId, tenantId, errorMsg);
    return { success: false, error: errorMsg };
  }
}

async function markFailed(
  outboundId: string,
  ticketId: string,
  tenantId: string,
  error: string
): Promise<void> {
  await prisma.marketplaceOutboundMessage.update({
    where: { id: outboundId },
    data: { status: "FAILED", error },
  });

  await prisma.ticketEvent.create({
    data: {
      ticketId,
      tenantId,
      type: "OUTBOUND_FAILED" as any,
      actorType: EventActorType.SYSTEM,
      payload: { channel: "AMAZON", error, outboundId },
    },
  });
}
