// src/modules/billing/billingGuards.service.ts

import { prisma } from "../../lib/db";

export interface AiQuotaDecision {
  allowed: boolean;
  reason?: "hard_cap_reached" | "no_plan" | "unknown";
  softWarning?: boolean;
}

/**
 * Détermine si l'IA est autorisée à consommer pour le tenant sur la période courante.
 * Modèle B : hard cap + auto-recharge
 */
export async function canConsumeAi(tenantId: string): Promise<AiQuotaDecision> {
  const plan = await prisma.tenantBillingPlan.findFirst({
    where: { tenantId },
    orderBy: { updatedAt: "desc" },
  });

  if (!plan) {
    return { allowed: false, reason: "no_plan" };
  }

  // Récupérer la période courante (mois)
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

  let usage = await prisma.tenantQuotaUsage.findFirst({
    where: {
      tenantId,
      periodStart,
      periodEnd,
    },
  });

  if (!usage) {
    usage = await prisma.tenantQuotaUsage.create({
      data: {
        tenantId,
        periodStart,
        periodEnd,
        ticketsCount: 0,
        aiActionsCount: 0,
        autoRecharges: 0,
      },
    });
  }

  const quota = plan.ticketMonthlyQuota + usage.autoRecharges * plan.autoRechargeUnits;

  const used = usage.ticketsCount; // On part sur le compteur ticketsCount comme unité principale pour l'instant

  const softLimit = Math.floor((quota * plan.softLimitPercent) / 100);
  const hardLimit = Math.floor((quota * plan.hardLimitPercent) / 100);

  const softWarning = used >= softLimit;

  if (used < hardLimit) {
    return { allowed: true, softWarning };
  }

  // hard limit atteint
  if (plan.autoRechargeEnabled) {
    // auto-recharge : on incrémente autoRecharges, ce qui augmente le quota virtuel
    await prisma.tenantQuotaUsage.update({
      where: { id: usage.id },
      data: { autoRecharges: usage.autoRecharges + 1, lastUpdatedAt: new Date() },
    });

    return { allowed: true, softWarning: true };
  }

  return { allowed: false, reason: "hard_cap_reached", softWarning: true };
}

