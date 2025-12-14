// src/modules/ai/aiSafetyGate.service.ts

import { prisma } from "../../lib/db";
import { env } from "../../config/env";
import type { Ticket, TicketMessage, AiRule } from "@prisma/client";

/**
 * Keywords sensibles qui bloquent l'auto-send
 */
const SENSITIVE_KEYWORDS = [
  "a-to-z",
  "chargeback",
  "litige",
  "plainte",
  "avocat",
  "tribunal",
  "fraude",
  "arnaque",
  "remboursement immédiat",
  "police",
  "scam",
  "lawsuit",
  "legal action",
  "refund immediately",
  "money back",
] as const;

/**
 * Canaux autorisés pour l'auto-send (configurable)
 */
const ALLOWED_CHANNELS = ["AMAZON", "MANUAL"] as const;

export type SafetyCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Vérifie si l'auto-send est autorisé pour un ticket donné.
 */
export async function isAutoSendAllowed(params: {
  ticket: Ticket;
  lastMessage: TicketMessage | null;
  tenantMode: string;
  rule: { id: string; executionMode: string | null };
  draftReply: string;
}): Promise<SafetyCheckResult> {
  const { ticket, lastMessage, tenantMode, rule, draftReply } = params;

  // 1. Feature flag désactivé
  if (env.KEYBUZZ_AI_AUTOSEND_ENABLED !== "true") {
    return { allowed: false, reason: "feature_disabled" };
  }

  // 2. Tenant pas en mode AUTO
  if (tenantMode !== "auto") {
    return { allowed: false, reason: "tenant_not_auto" };
  }

  // 3. Rule pas en mode AUTO_EXECUTE
  if (rule.executionMode !== "AUTO_EXECUTE") {
    return { allowed: false, reason: "rule_not_auto" };
  }

  // 4. Statut ticket bloquant
  if (ticket.status === "ESCALATED" || ticket.status === "CLOSED") {
    return { allowed: false, reason: "ticket_status_blocked" };
  }

  // 5. Canal non autorisé
  if (!ALLOWED_CHANNELS.includes(ticket.channel as typeof ALLOWED_CHANNELS[number])) {
    return { allowed: false, reason: "channel_not_allowed" };
  }

  // 6. Draft vide ou trop long
  if (!draftReply || draftReply.trim().length === 0) {
    return { allowed: false, reason: "draft_empty" };
  }
  if (draftReply.length > 1200) {
    return { allowed: false, reason: "draft_too_long" };
  }

  // 7. Keywords sensibles dans le dernier message client
  if (lastMessage) {
    const messageLower = lastMessage.body.toLowerCase();
    const foundKeyword = SENSITIVE_KEYWORDS.find((kw) =>
      messageLower.includes(kw)
    );
    if (foundKeyword) {
      return {
        allowed: false,
        reason: `sensitive_keyword_detected: ${foundKeyword}`,
      };
    }
  }

  // 8. Anti-spam : limiter nombre d'auto-replies par ticket
  const cooldownMinutes = env.KEYBUZZ_AI_AUTOSEND_COOLDOWN_MINUTES;
  const maxPerTicket = env.KEYBUZZ_AI_AUTOSEND_MAX_PER_TICKET;

  const recentAutoReplies = await prisma.ticketEvent.count({
    where: {
      ticketId: ticket.id,
      type: "AI_REPLY_SENT",
      createdAt: {
        gte: new Date(Date.now() - cooldownMinutes * 60 * 1000),
      },
    },
  });

  if (recentAutoReplies >= maxPerTicket) {
    return {
      allowed: false,
      reason: `rate_limit_exceeded: ${recentAutoReplies}/${maxPerTicket} in ${cooldownMinutes}min`,
    };
  }

  // Toutes les vérifications passées
  return { allowed: true };
}

