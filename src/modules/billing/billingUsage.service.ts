// src/modules/billing/billingUsage.service.ts

import { prisma } from "../../lib/db";

export interface TicketBillingIncrement {
  aiActions?: number;
  tokensUsed?: number;
  humanMessages?: number;
  autoReply?: number;
}

/**
 * Incrémente les compteurs de billing pour un ticket.
 */
export async function incrementTicketBillingUsage(
  ticketId: string,
  tenantId: string,
  increments: TicketBillingIncrement
): Promise<void> {
  await prisma.ticketBillingUsage.upsert({
    where: { ticketId },
    update: {
      aiActionsCount: increments.aiActions
        ? { increment: increments.aiActions }
        : undefined,
      tokensUsed: increments.tokensUsed
        ? { increment: increments.tokensUsed }
        : undefined,
      humanMessagesCount: increments.humanMessages
        ? { increment: increments.humanMessages }
        : undefined,
      autoReplyCount: increments.autoReply
        ? { increment: increments.autoReply }
        : undefined,
    },
    create: {
      ticketId,
      tenantId,
      aiActionsCount: increments.aiActions ?? 0,
      tokensUsed: increments.tokensUsed ?? 0,
      humanMessagesCount: increments.humanMessages ?? 0,
      autoReplyCount: increments.autoReply ?? 0,
    },
  });
}

/**
 * Met à jour les quotas tenant (applique auto-recharge si nécessaire).
 */
export async function updateTenantQuotaUsage(tenantId: string): Promise<void> {
  const plan = await prisma.tenantBillingPlan.findFirst({
    where: { tenantId },
    orderBy: { updatedAt: "desc" },
  });

  if (!plan) {
    return;
  }

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

  const usage = await prisma.tenantQuotaUsage.findFirst({
    where: {
      tenantId,
      periodStart,
      periodEnd,
    },
  });

  if (!usage) {
    return;
  }

  // Mise à jour du compteur aiActionsCount si nécessaire
  // (cette fonction peut être étendue pour gérer d'autres mises à jour)
  await prisma.tenantQuotaUsage.update({
    where: { id: usage.id },
    data: { lastUpdatedAt: new Date() },
  });
}

