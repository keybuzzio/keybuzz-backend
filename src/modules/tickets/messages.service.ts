import { prisma } from "../../lib/db";
import type { AuthUser } from "../auth/auth.types";

// Squelettes pour PH11-04C : messages + événements + billing + SLA/IA.

export async function listMessagesForTicket(user: AuthUser, ticketId: string) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return [];
  if (user.role !== "super_admin" && ticket.tenantId !== user.tenantId) return [];

  return prisma.ticketMessage.findMany({
    where: { ticketId },
    orderBy: { sentAt: "asc" },
  });
}

export async function addMessageToTicket(
  user: AuthUser,
  ticketId: string,
  body: string,
  isInternal: boolean
) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    throw new Error("Ticket not found");
  }
  if (user.role !== "super_admin" && ticket.tenantId !== user.tenantId) {
    throw new Error("Forbidden");
  }

  const message = await prisma.ticketMessage.create({
    data: {
      ticketId,
      tenantId: ticket.tenantId,
      senderType: isInternal ? "AGENT" : "CUSTOMER",
      senderId: user.id,
      senderName: user.fullName,
      body,
      isInternal,
      source: isInternal ? "KEYBUZZ_UI" : "API",
    },
  });

  await prisma.ticketEvent.create({
    data: {
      ticketId,
      tenantId: ticket.tenantId,
      type: isInternal ? "MESSAGE_SENT" : "MESSAGE_RECEIVED",
      actorType: isInternal ? "AGENT" : "CUSTOMER",
      actorId: user.id,
    },
  });

  await prisma.ticketBillingUsage.upsert({
    where: { ticketId },
    update: {
      humanMessagesCount: { increment: 1 },
    },
    create: {
      ticketId,
      tenantId: ticket.tenantId,
      humanMessagesCount: 1,
    },
  });

  return message;
}

