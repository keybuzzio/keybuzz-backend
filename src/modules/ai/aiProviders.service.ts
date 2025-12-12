// src/modules/ai/aiProviders.service.ts

import { env } from "../../config/env";
import fetch from "node-fetch";

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
  tokensInput?: number;
  tokensOutput?: number;
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
 * Supporte mock, LiteLLM, et plus tard OpenAI/Anthropic.
 */
export async function generateReply(req: AiProviderRequest): Promise<AiProviderResponse> {
  const provider = getProvider();

  if (provider === "mock") {
    return mockGenerateReply(req);
  }

  if (provider === "litellm") {
    return litellmGenerateReply(req);
  }

  // TODO PH11-05E : implémenter OpenAI/Anthropic
  // Pour l'instant, fallback safe sur mock
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
    tokensInput: 30,
    tokensOutput: 20,
    raw: { provider: "mock" },
  };
}

async function litellmGenerateReply(req: AiProviderRequest): Promise<AiProviderResponse> {
  const baseUrl = env.KEYBUZZ_AI_BASE_URL || "https://llm.keybuzz.io";
  const apiKey = env.KEYBUZZ_AI_API_KEY;

  if (!apiKey) {
    throw new Error("KEYBUZZ_AI_API_KEY is required when using litellm provider");
  }

  // Convertir le prompt en format messages OpenAI/LiteLLM
  const messages = [
    {
      role: "system" as const,
      content: "You are KeyBuzz AI, a helpful customer support assistant for e-commerce.",
    },
    {
      role: "user" as const,
      content: req.prompt,
    },
  ];

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model: req.model,
      messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LiteLLM error ${res.status}: ${err}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const content = json.choices?.[0]?.message?.content ?? "";
  const tokensInput = json.usage?.prompt_tokens;
  const tokensOutput = json.usage?.completion_tokens;
  const totalTokens = json.usage?.total_tokens ?? (tokensInput ?? 0) + (tokensOutput ?? 0);

  return {
    content,
    tokensUsed: totalTokens,
    tokensInput,
    tokensOutput,
    raw: json,
  };
}

