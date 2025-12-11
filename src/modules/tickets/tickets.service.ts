import { prisma } from "../../lib/db";
import type { AuthUser } from "../auth/auth.types";
import type { TicketDto } from "./tickets.types";
import type { Ticket } from "@prisma/client";

export async function listTicketsForUser(user: AuthUser): Promise<TicketDto[]> {
  if (!user.tenantId && user.role !== "super_admin") {
    return [];
  }

  const where = user.role === "super_admin" ? {} : { tenantId: user.tenantId! };

  const records = await prisma.ticket.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return records.map(mapTicketToDto);
}

export async function getTicketById(
  user: AuthUser,
  ticketId: string
): Promise<TicketDto | null> {
  const record = await prisma.ticket.findUnique({
    where: { id: ticketId },
  });

  if (!record) return null;

  if (user.role !== "super_admin" && record.tenantId !== user.tenantId) {
    return null;
  }

  return mapTicketToDto(record);
}

// TODO PH11-04C: lors du premier message AGENT/AI, renseigner firstResponseAt ; lors du passage en RESOLVED, renseigner resolvedAt.
function mapTicketToDto(t: Ticket): TicketDto {
  return {
    id: t.id,
    subject: t.subject,
    customerName: t.customerName,
    customerEmail: t.customerEmail ?? undefined,
    channel: t.channel.toLowerCase(),
    status: t.status.toLowerCase() as TicketDto["status"],
    priority: t.priority.toLowerCase() as TicketDto["priority"],
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    firstResponseAt: t.firstResponseAt?.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString(),
    category: t.category ?? undefined,
    sentiment: t.sentiment ?? undefined,
  };
}

