// src/modules/ai/aiModelRegistry.service.ts

export type AiModelTier = "cheap" | "standard" | "premium";

export interface AiModelProfile {
  alias: string;
  provider: "litellm";
  tier: AiModelTier;
  maxContext: number;
  costPer1kInputCents: number;
  costPer1kOutputCents: number;
}

export const AI_MODEL_REGISTRY: Record<string, AiModelProfile> = {
  "kbz-cheap": {
    alias: "kbz-cheap",
    provider: "litellm",
    tier: "cheap",
    maxContext: 8000,
    costPer1kInputCents: 1,
    costPer1kOutputCents: 2,
  },
  "kbz-standard": {
    alias: "kbz-standard",
    provider: "litellm",
    tier: "standard",
    maxContext: 16000,
    costPer1kInputCents: 4,
    costPer1kOutputCents: 6,
  },
  "kbz-premium": {
    alias: "kbz-premium",
    provider: "litellm",
    tier: "premium",
    maxContext: 32000,
    costPer1kInputCents: 10,
    costPer1kOutputCents: 15,
  },
};

