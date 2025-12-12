// src/modules/ai/aiProviders.service.ts

import { env } from "../../config/env";

export interface AiProviderRequest {
  model: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  lang?: string;
}

export interface AiProviderResponse {
  content: string;
  tokensUsed: number;
  raw?: unknown;
}

export type AiProviderName = "openai" | "anthropic" | "litellm" | "mock";

function getProvider(): AiProviderName {
  // On lit la config depuis l'env, avec fallback sur "mock" pour l'instant
  const provider = (env.KEYBUZZ_AI_PROVIDER || "mock").toLowerCase();
  if (provider === "openai" || provider === "anthropic" || provider === "litellm") {
    return provider;
  }
  return "mock";
}

/**
 * Fonction principale pour générer une réponse via KeyBuzz AI.
 * Pour l'instant, on utilise un provider "mock" par défaut.
 * Plus tard, on branchera OpenAI/Anthropic/LiteLLM ici.
 */
export async function generateReply(req: AiProviderRequest): Promise<AiProviderResponse> {
  const provider = getProvider();

  if (provider === "mock") {
    return mockGenerateReply(req);
  }

  // TODO PH11-05B : implémenter les vrais providers (OpenAI, Anthropic, etc.)
  // Ici, on garde un fallback safe.
  return mockGenerateReply(req);
}

async function mockGenerateReply(req: AiProviderRequest): Promise<AiProviderResponse> {
  const content = [
    "[KeyBuzz AI MOCK]",
    `Modèle: ${req.model}`,
    `Langue cible: ${req.lang || "auto"}`,
    "",
    "Ceci est une réponse simulée par KeyBuzz AI.",
    "Le vrai modèle IA sera branché en PH11-05B.",
  ].join("\n");

  return {
    content,
    tokensUsed: 50, // valeur fictive
    raw: { provider: "mock" },
  };
}

