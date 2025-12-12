// src/modules/tickets/ticketEvents.service.ts

import { prisma } from "../../lib/db";
import type { EventActorType, TicketEventType } from "@prisma/client";

export async function createTicketEvent(params: {
  ticketId: string;
  tenantId: string;
  type: TicketEventType;
  actorType: EventActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}) {
  return prisma.ticketEvent.create({
    data: {
      ticketId: params.ticketId,
      tenantId: params.tenantId,
      type: params.type,
      actorType: params.actorType,
      actorId: params.actorId ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: (params.payload as any) ?? undefined,
    },
  });
}

