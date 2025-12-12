// src/modules/ai/aiRules.service.ts

import { prisma } from "../../lib/db";
import { runAiForTicket } from "./aiEngine.service";
import type { AuthUser } from "../auth/auth.types";
import { AiExecutionResult, AiTriggerType } from "@prisma/client";

/**
 * Évalue les règles IA pour un ticket donné et exécute l'IA si des règles matchent.
 * Crée des brouillons IA (AiResponseDraft) et des logs d'exécution (AiRuleExecution).
 */
export async function evaluateAiRulesForTicket(
  ticketId: string,
  trigger: string,
  userContext?: AuthUser
): Promise<void> {
  // Charger le ticket avec son tenant
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: { tenant: true },
  });

  if (!ticket) {
    return; // Ticket inexistant, rien à faire
  }

  // Charger les règles actives pour ce tenant et ce trigger
  const rules = await prisma.aiRule.findMany({
    where: {
      tenantId: ticket.tenantId,
      isActive: true,
      trigger: trigger as AiTriggerType,
    },
    include: {
      conditions: true,
      actions: true,
    },
  });

  if (rules.length === 0) {
    return; // Aucune règle active pour ce trigger
  }

  // Filtrer les règles qui matchent les conditions
  const matchedRules = rules.filter((rule) => {
    // Si aucune condition, la règle matche toujours
    if (rule.conditions.length === 0) {
      return true;
    }

    // Vérifier que toutes les conditions sont satisfaites
    return rule.conditions.every((condition) => {
      const ticketValue = getTicketFieldValue(ticket, condition.field);
      return evaluateCondition(ticketValue, condition.operator, condition.value);
    });
  });

  if (matchedRules.length === 0) {
    return; // Aucune règle ne matche les conditions
  }

  // Pour chaque règle matchée, exécuter l'IA (mock) et logguer brouillon + exécution
  for (const rule of matchedRules) {
    try {
      const outcome = await runAiForTicket(ticket.id, userContext);

      if (outcome.draftReply) {
        // Création d'un AiResponseDraft lié au ticket
        await prisma.aiResponseDraft.create({
          data: {
            ticketId: ticket.id,
            tenantId: ticket.tenantId,
            createdByRule: rule.id,
            body: outcome.draftReply,
            confidence: null, // on mettra confiance réelle plus tard
          },
        });
      }

      await prisma.aiRuleExecution.create({
        data: {
          ruleId: rule.id,
          ticketId: ticket.id,
          tenantId: ticket.tenantId,
          result: AiExecutionResult.SUCCESS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          details: outcome.providerResponse as unknown as any, // JSON, cast si nécessaire
        },
      });
    } catch (err) {
      // Loggue l'échec en DB pour debug futur
      await prisma.aiRuleExecution.create({
        data: {
          ruleId: rule.id,
          ticketId: ticket.id,
          tenantId: ticket.tenantId,
          result: AiExecutionResult.FAILED,
          details: { error: (err as Error).message },
        },
      });
    }
  }
}

/**
 * Récupère la valeur d'un champ du ticket pour l'évaluation des conditions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTicketFieldValue(ticket: any, field: string): string | number | null {
  switch (field) {
    case "status":
      return ticket.status;
    case "priority":
      return ticket.priority;
    case "channel":
      return ticket.channel;
    case "customerEmail":
      return ticket.customerEmail || "";
    case "subject":
      return ticket.subject;
    default:
      return null;
  }
}

/**
 * Évalue une condition selon l'opérateur.
 */
function evaluateCondition(
  ticketValue: string | number | null,
  operator: string,
  conditionValue: string
): boolean {
  if (ticketValue === null) {
    return false;
  }

  const ticketValueStr = String(ticketValue).toLowerCase();
  const conditionValueStr = conditionValue.toLowerCase();

  switch (operator) {
    case "EQUALS":
      return ticketValueStr === conditionValueStr;
    case "NOT_EQUALS":
      return ticketValueStr !== conditionValueStr;
    case "CONTAINS":
      return ticketValueStr.includes(conditionValueStr);
    case "NOT_CONTAINS":
      return !ticketValueStr.includes(conditionValueStr);
    case "IN":
      return conditionValue.split(",").some((v) => v.trim().toLowerCase() === ticketValueStr);
    case "NOT_IN":
      return !conditionValue.split(",").some((v) => v.trim().toLowerCase() === ticketValueStr);
    case "GREATER_THAN":
      return Number(ticketValue) > Number(conditionValue);
    case "LESS_THAN":
      return Number(ticketValue) < Number(conditionValue);
    default:
      return false;
  }
}

