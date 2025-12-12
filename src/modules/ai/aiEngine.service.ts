// src/modules/ai/aiEngine.service.ts

import { prisma } from "../../lib/db";
import type { AuthUser } from "../auth/auth.types";
import { generateReply, type AiProviderResponse } from "./aiProviders.service";

/**
 * Résultat d'une exécution IA sur un ticket.
 */
export interface AiExecutionOutcome {
  draftReply?: string;
  tokensUsed: number;
  providerResponse: AiProviderResponse;
}

/**
 * Exécute une étape IA pour un ticket donné (ex: classification ou suggestion de réponse).
 * Pour l'instant, ne fait qu'un appel mock qui renvoie un brouillon générique.
 * Plus tard (PH11-05B/C), on utilisera vraiment le ticket, le dernier message,
 * la langue, le tenant, les règles, etc.
 */
export async function runAiForTicket(
  ticketId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userContext?: AuthUser
): Promise<AiExecutionOutcome> {
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

  const prompt = buildBasicPromptForTicket(ticket.id);

  const providerResponse = await generateReply({
    model: "keybuzz-ai-mock",
    prompt,
    maxTokens: 400,
    temperature: 0.2,
    // lang: ticket.language ?? undefined, // futur champ
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

