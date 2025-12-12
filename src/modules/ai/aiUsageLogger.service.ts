// src/modules/ai/aiUsageLogger.service.ts

import { prisma } from "../../lib/db";

export async function logAiUsage(params: {
  tenantId: string;
  ticketId?: string;
  ruleId?: string;
  provider: string;
  model: string;
  taskType: string;
  tokensInput: number;
  tokensOutput: number;
  estimatedCost: number;
  latencyMs: number;
}) {
  await prisma.aiUsageLog.create({
    data: params,
  });
}

