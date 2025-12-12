// src/modules/ai/budgetController.service.ts

import { prisma } from "../../lib/db";

export async function getBudgetPressure(
  tenantId: string
): Promise<"low" | "medium" | "high"> {
  const budget = await prisma.tenantAiBudget.findUnique({
    where: { tenantId },
  });

  if (!budget) return "medium";

  const usage = await prisma.aiUsageLog.aggregate({
    where: { tenantId },
    _sum: { estimatedCost: true },
  });

  const spent = usage._sum.estimatedCost ?? 0;
  const percent = (spent / budget.monthlyBudgetCents) * 100;

  if (percent >= budget.hardLimitPercent) return "high";
  if (percent >= budget.downgradePercent) return "medium";
  return "low";
}

