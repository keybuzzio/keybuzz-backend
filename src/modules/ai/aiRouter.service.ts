// src/modules/ai/aiRouter.service.ts

import { AI_MODEL_REGISTRY } from "./aiModelRegistry.service";

export type AiTaskType =
  | "classify"
  | "sentiment"
  | "translate"
  | "draft_reply"
  | "auto_reply";

export function selectModelForTask(params: {
  taskType: AiTaskType;
  mode: "off" | "assist" | "auto";
  budgetPressure: "low" | "medium" | "high";
}): string {
  if (params.budgetPressure === "high") {
    return "kbz-cheap";
  }

  if (params.taskType === "classify" || params.taskType === "sentiment") {
    return "kbz-cheap";
  }

  if (params.taskType === "draft_reply") {
    return params.mode === "auto" ? "kbz-standard" : "kbz-cheap";
  }

  if (params.taskType === "auto_reply") {
    return "kbz-premium";
  }

  return "kbz-cheap";
}

export function getModelProfile(alias: string) {
  return AI_MODEL_REGISTRY[alias];
}

