// src/modules/ai/aiCostEstimator.service.ts

import { AI_MODEL_REGISTRY } from "./aiModelRegistry.service";

export function estimateCostCents(params: {
  model: string;
  tokensInput: number;
  tokensOutput: number;
}): number {
  const profile = AI_MODEL_REGISTRY[params.model];
  if (!profile) return 0;

  const inputCost = (params.tokensInput / 1000) * profile.costPer1kInputCents;
  const outputCost = (params.tokensOutput / 1000) * profile.costPer1kOutputCents;

  return Math.ceil(inputCost + outputCost);
}

