// src/modules/ai/aiExecutionPolicy.service.ts

import { prisma } from "../../lib/db";
import type { AiActionType } from "@prisma/client";

export type TenantAiMode = "off" | "assist" | "auto";

/**
 * Récupère le mode IA d'un tenant.
 * Pour PH11-05C on fait simple : mode par tenant basé sur le plan billing.
 * TODO PH11-06/PH12: remplacer par une vraie table TenantAiSettings.
 */
export async function getTenantAiMode(tenantId: string): Promise<TenantAiMode> {
  const plan = await prisma.tenantBillingPlan.findFirst({
    where: { tenantId },
    orderBy: { updatedAt: "desc" },
  });

  if (!plan) return "assist";

  // Logique temporaire :
  // - DEV / STARTER: assist
  // - PRO / ENTERPRISE: auto
  const planId = plan.plan.toString().toLowerCase();
  if (planId === "dev" || planId === "starter") return "assist";
  return "auto";
}

/**
 * Filtre les actions IA en fonction du mode.
 * PH11-05C: aucun SEND_REPLY auto.
 */
export function filterAllowedActions(
  actions: { type: AiActionType; params?: unknown }[],
  mode: TenantAiMode
): { type: AiActionType; params?: unknown }[] {
  if (mode === "off") return [];

  // assist: pas d'actions appliquées automatiquement, seulement des drafts/logs
  if (mode === "assist") return [];

  // auto:
  // Autorisé: SET_STATUS, ESCALATE, ADD_TAG
  // Interdit en auto pour PH11-05C: SEND_REPLY, REQUEST_MORE_INFO (draft-only)
  return actions.filter((a) => ["SET_STATUS", "ESCALATE", "ADD_TAG"].includes(a.type));
}

