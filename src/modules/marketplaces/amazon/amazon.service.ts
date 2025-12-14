// src/modules/marketplaces/amazon/amazon.service.ts

import { prisma } from "../../../lib/db";
import type { AmazonInboundMessage } from "./amazon.types";
import { createTicketEvent } from "../../tickets/ticketEvents.service";
import { MarketplaceType, TicketChannel, TicketStatus } from "@prisma/client";

/**
 * Ensure a MarketplaceConnection exists for Amazon (dev mode)
 */
export async function ensureAmazonConnection(tenantId: string) {
  let connection = await prisma.marketplaceConnection.findFirst({
    where: {
      tenantId,
      type: MarketplaceType.AMAZON,
    },
  });

  if (!connection) {
    connection = await prisma.marketplaceConnection.create({
      data: {
        tenantId,
        type: MarketplaceType.AMAZON,
        status: "CONNECTED", // Mock mode: auto-connected
        displayName: "Amazon (Dev Mock)",
        region: "EU",
      },
    });
  }

  return connection;
}

/**
 * Upsert ExternalMessage (idempotent)
 */
export async function upsertExternalMessage(
  tenantId: string,
  connectionId: string,
  message: AmazonInboundMessage
) {
  return prisma.externalMessage.upsert({
    where: {
      type_connectionId_externalId: {
        type: MarketplaceType.AMAZON,
        connectionId,
        externalId: message.externalId,
      },
    },
    update: {
      // Si déjà existant, ne rien faire (idempotence)
    },
    create: {
      tenantId,
      connectionId,
      type: MarketplaceType.AMAZON,
      externalId: message.externalId,
      threadId: message.threadId,
      orderId: message.orderId,
      buyerName: message.buyerName,
      buyerEmail: message.buyerEmail,
      language: message.language,
      receivedAt: new Date(message.receivedAt),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      raw: message.raw as any,
    },
  });
}

/**
 * Map ExternalMessage to Ticket + TicketMessage
 * Idempotent: ne crée pas de duplicatas
 */
export async function mapExternalMessageToTicket(
  tenantId: string,
  externalMessage: {
    id: string;
    externalId: string;
    threadId: string | null;
    orderId: string | null;
    buyerName: string | null;
    buyerEmail: string | null;
    language: string | null;
    receivedAt: Date;
    ticketId: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any;
  },
  messageBody: string,
  messageSubject?: string
) {
  // Si déjà mappé, skip
  if (externalMessage.ticketId) {
    return;
  }

  // Chercher ticket existant par threadId ou orderId
  const existingTicket = await prisma.ticket.findFirst({
    where: {
      tenantId,
      OR: [
        { externalId: externalMessage.threadId || externalMessage.externalId },
        { externalId: externalMessage.orderId || undefined },
      ],
    },
  });

  if (existingTicket) {
    // Ticket existe, ajouter message
    const existingMessage = await prisma.ticketMessage.findFirst({
      where: {
        ticketId: existingTicket.id,
        body: messageBody, // Simple dup check
      },
    });

    if (!existingMessage) {
      await prisma.ticketMessage.create({
        data: {
          ticketId: existingTicket.id,
          tenantId,
          senderType: "CUSTOMER",
          senderId: null,
          senderName: externalMessage.buyerName || "Amazon Buyer",
          body: messageBody,
          isInternal: false,
          source: "MARKETPLACE",
        },
      });

      await createTicketEvent({
        ticketId: existingTicket.id,
        tenantId,
        type: "MESSAGE_RECEIVED",
        actorType: "CUSTOMER",
        payload: {
          source: "amazon",
          externalId: externalMessage.externalId,
        },
      });
    }

    // Update ExternalMessage.ticketId
    await prisma.externalMessage.update({
      where: { id: externalMessage.id },
      data: { ticketId: existingTicket.id },
    });

    return;
  }

  // Créer nouveau ticket
  const ticket = await prisma.ticket.create({
    data: {
      tenantId,
      subject:
        messageSubject ||
        messageBody.substring(0, 100) ||
        "New Amazon message",
      channel: TicketChannel.AMAZON,
      status: TicketStatus.OPEN,
      priority: "NORMAL",
      customerName: externalMessage.buyerName || "Amazon Buyer",
      customerEmail: externalMessage.buyerEmail || undefined,
      externalId: externalMessage.threadId || externalMessage.externalId,
    },
  });

  // Créer premier message
  await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      tenantId,
      senderType: "CUSTOMER",
      senderId: null,
      senderName: externalMessage.buyerName || "Amazon Buyer",
      body: messageBody,
      isInternal: false,
      source: "MARKETPLACE",
    },
  });

  // Event MESSAGE_RECEIVED
  await createTicketEvent({
    ticketId: ticket.id,
    tenantId,
    type: "MESSAGE_RECEIVED",
    actorType: "CUSTOMER",
    payload: {
      source: "amazon",
      externalId: externalMessage.externalId,
      orderId: externalMessage.orderId,
    },
  });

  // Update ExternalMessage.ticketId
  await prisma.externalMessage.update({
    where: { id: externalMessage.id },
    data: { ticketId: ticket.id },
  });

  // Init billing usage
  await prisma.ticketBillingUsage.create({
    data: {
      ticketId: ticket.id,
      tenantId,
      humanMessagesCount: 1,
    },
  });
}

