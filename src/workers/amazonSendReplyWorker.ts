// src/workers/amazonSendReplyWorker.ts
// PH11-06B.9 - Amazon Send Reply Worker

import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { sendBuyerMessage } from "../modules/marketplaces/amazon/amazon.spapi";

const prisma = new PrismaClient();

const BLOCKED_KEYWORDS = [
  "refund", "lawsuit", "attorney", "lawyer", "legal action",
  "sue you", "police", "fraud",
];

interface SendReplyPayload {
  ticketId: string;
  message: string;
  amazonOrderId?: string;
  marketplaceId?: string;
}

function containsBlockedKeywords(message: string): string | null {
  const lowerMessage = message.toLowerCase();
  for (const keyword of BLOCKED_KEYWORDS) {
    if (lowerMessage.includes(keyword.toLowerCase())) {
      return keyword;
    }
  }
  return null;
}

function generateBodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").substring(0, 32);
}

export async function processAmazonSendReply(
  jobId: string,
  tenantId: string,
  payload: SendReplyPayload
): Promise<{ success: boolean; error?: string }> {
  console.log(`[AmazonSendReply] Processing job ${jobId} for tenant ${tenantId}`);

  const { ticketId, message, amazonOrderId, marketplaceId } = payload;

  // Validate ticket
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, tenantId },
  });

  if (!ticket) {
    return { success: false, error: "Ticket not found or access denied" };
  }

  if (ticket.status === "RESOLVED") {
    return { success: false, error: "Cannot reply to RESOLVED ticket" };
  }

  const blockedKeyword = containsBlockedKeywords(message);
  if (blockedKeyword) {
    return { success: false, error: `Message contains blocked keyword: ${blockedKeyword}` };
  }

  if (message.length > 2000) {
    return { success: false, error: "Message too long (max 2000 characters)" };
  }

  const orderId = amazonOrderId || ticket.externalId;
  if (!orderId) {
    return { success: false, error: "No Amazon order ID available" };
  }

  const bodyHash = generateBodyHash(message);

  const existingMessage = await prisma.marketplaceOutboundMessage.findFirst({
    where: { ticketId, bodyHash, status: "SENT" },
  });

  if (existingMessage) {
    console.log(`[AmazonSendReply] Duplicate message detected, skipping`);
    return { success: true };
  }

  const outboundMessage = await prisma.marketplaceOutboundMessage.create({
    data: {
      tenantId,
      ticketId,
      channel: "AMAZON",
      marketplaceType: "AMAZON",
      externalThreadId: orderId,
      orderId,
      toAddress: ticket.customerEmail || "buyer@marketplace.amazon.com",
      body: message,
      bodyHash,
      status: "PENDING",
    },
  });

  const result = await sendBuyerMessage({
    tenantId,
    amazonOrderId: orderId,
    message,
    marketplaceId,
  });

  if (result.success) {
    await prisma.marketplaceOutboundMessage.update({
      where: { id: outboundMessage.id },
      data: {
        status: "SENT",
        providerMessageId: result.messageId,
        sentAt: new Date(),
        attempts: 1,
      },
    });

    // Create ticket event (using payload field)
    await prisma.ticketEvent.create({
      data: {
        ticketId,
        tenantId,
        type: "MESSAGE_SENT",
        actorType: "SYSTEM",
        actorId: "amazon-worker",
        payload: {
          outboundMessageId: outboundMessage.id,
          amazonMessageId: result.messageId,
          channel: "AMAZON",
        },
      },
    });

    console.log(`[AmazonSendReply] Message sent successfully: ${result.messageId}`);
    return { success: true };
  } else {
    await prisma.marketplaceOutboundMessage.update({
      where: { id: outboundMessage.id },
      data: {
        status: "FAILED",
        error: result.error,
        attempts: 1,
      },
    });

    await prisma.ticketEvent.create({
      data: {
        ticketId,
        tenantId,
        type: "STATUS_CHANGED",
        actorType: "SYSTEM",
        actorId: "amazon-worker",
        payload: {
          action: "outbound_failed",
          outboundMessageId: outboundMessage.id,
          error: result.error,
          errorCode: result.error === "oauth_not_connected" ? "OAUTH_NOT_CONNECTED" : "SEND_FAILED",
          channel: "AMAZON",
        },
      },
    });

    console.error(`[AmazonSendReply] Message failed: ${result.error}`);
    return { success: false, error: result.error };
  }
}
