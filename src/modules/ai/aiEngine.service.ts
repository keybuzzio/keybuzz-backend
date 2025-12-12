// src/modules/ai/aiEngine.service.ts

import { prisma } from "../../lib/db";
import type { AuthUser } from "../auth/auth.types";
import { generateReply, type AiProviderResponse } from "./aiProviders.service";
import { getBudgetPressure } from "./budgetController.service";
import { selectModelForTask, type AiTaskType } from "./aiRouter.service";
import { estimateCostCents } from "./aiCostEstimator.service";
import { logAiUsage } from "./aiUsageLogger.service";
import type { TenantAiMode } from "./aiExecutionPolicy.service";

/**
 * Résultat d'une exécution IA sur un ticket.
 */
export interface AiExecutionOutcome {
  draftReply?: string;
  tokensUsed: number;
  providerResponse: AiProviderResponse;
}

export interface RunAiInput {
  ticketId: string;
  userContext?: AuthUser;
  ruleId?: string;
  mode?: TenantAiMode;
  taskType?: AiTaskType;
}

/**
 * Exécute une étape IA pour un ticket donné (ex: classification ou suggestion de réponse).
 * Pour l'instant, ne fait qu'un appel mock qui renvoie un brouillon générique.
 * Plus tard (PH11-05B/C), on utilisera vraiment le ticket, le dernier message,
 * la langue, le tenant, les règles, etc.
 */
export async function runAiForTicket(params: RunAiInput): Promise<AiExecutionOutcome> {
  const {
    ticketId,
    userContext, // eslint-disable-line @typescript-eslint/no-unused-vars
    ruleId,
    mode = "assist",
    taskType = "draft_reply",
  } = params;

  // TODO: en PH11-05B/C, charger le ticket, les messages, le tenant, les rules, etc.
  // Pour l'instant, on vérifie juste que le ticket existe (ou on ignore silencieusement).
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
  });

  if (!ticket) {
    // Ticket inexistant → rien à faire
    return {
      draftReply: undefined,
      tokensUsed: 0,
      providerResponse: {
        content: "",
        tokensUsed: 0,
      },
    };
  }

  const budgetPressure = await getBudgetPressure(ticket.tenantId);
  const model = selectModelForTask({
    taskType,
    mode,
    budgetPressure,
  });

  const prompt = buildBasicPromptForTicket(ticket.id);

  const estimatedTokensInput = estimateTokens(prompt);
  const estimatedTokensOutput = 200; // estimation simple pour le mock
  const estimatedCost = estimateCostCents({
    model,
    tokensInput: estimatedTokensInput,
    tokensOutput: estimatedTokensOutput,
  });

  // Vérification rapide du budget hard cap (hors auto-recharge avancée)
  const budget = await prisma.tenantAiBudget.findUnique({
    where: { tenantId: ticket.tenantId },
  });

  if (budget) {
    const usage = await prisma.aiUsageLog.aggregate({
      where: { tenantId: ticket.tenantId },
      _sum: { estimatedCost: true },
    });
    const spent = usage._sum.estimatedCost ?? 0;
    const hardLimit = Math.floor((budget.monthlyBudgetCents * budget.hardLimitPercent) / 100);
    const projected = spent + estimatedCost;

    if (projected > hardLimit && !budget.autoRechargeEnabled) {
      throw new Error("AI budget exceeded (hard limit)");
    }
  }

  const startedAt = Date.now();
  const providerResponse = await generateReply({
    model,
    prompt,
    maxTokens: 400,
    temperature: 0.2,
    // lang: ticket.language ?? undefined, // futur champ
  });
  const latencyMs = Date.now() - startedAt;

  const tokensOutput = providerResponse.tokensUsed ?? estimatedTokensOutput;
  const finalCost = estimateCostCents({
    model,
    tokensInput: estimatedTokensInput,
    tokensOutput,
  });

  await logAiUsage({
    tenantId: ticket.tenantId,
    ticketId: ticket.id,
    ruleId,
    provider: "litellm",
    model,
    taskType,
    tokensInput: estimatedTokensInput,
    tokensOutput,
    estimatedCost: finalCost,
    latencyMs,
  });

  return {
    draftReply: providerResponse.content,
    tokensUsed: providerResponse.tokensUsed,
    providerResponse,
  };
}

/**
 * Construit un prompt très simple pour le mock.
 * En PH11-05B/C, on utilisera le contenu réel du ticket et des messages.
 */
function buildBasicPromptForTicket(ticketId: string): string {
  return [
    "Tu es KeyBuzz AI.",
    "Tu traites un ticket de support e-commerce.",
    "",
    `Ticket ID: ${ticketId}`,
    "",
    "Pour l'instant, ceci est un prompt de test.",
    "En PH11-05B/C, ce prompt contiendra le contexte réel du ticket.",
  ].join("\n");
}

function estimateTokens(prompt: string): number {
  // Estimation simple : ~4 caractères par token en moyenne.
  return Math.ceil(prompt.length / 4);
}

