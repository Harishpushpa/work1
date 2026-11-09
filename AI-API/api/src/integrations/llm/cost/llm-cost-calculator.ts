import { config } from "../../../platform/config";
import { Usage } from "../types";
import {
  SummaryInputCostBreakdown,
  SummaryInputTokenBreakdown,
} from "../types/summary-input-breakdown";

export interface LlmCostBreakdown {
  promptCost: number;
  completionCost: number;
  totalCost: number;
  inputBreakdown?: SummaryInputCostBreakdown;
}

export function calculateLlmCost(
  usage: Usage,
  inputTokenBreakdown?: SummaryInputTokenBreakdown
): LlmCostBreakdown {
  const inputPerMillion = config.llm.summarization.inputCostPerMillion;
  const outputPerMillion = config.llm.summarization.outputCostPerMillion;

  const promptCost = (usage.promptTokens / 1_000_000) * inputPerMillion;
  const completionCost =
    (usage.completionTokens / 1_000_000) * outputPerMillion;

  const inputBreakdown = inputTokenBreakdown
    ? calculateInputCostBreakdown(inputTokenBreakdown, inputPerMillion)
    : undefined;

  return {
    promptCost: roundCost(promptCost),
    completionCost: roundCost(completionCost),
    totalCost: roundCost(promptCost + completionCost),
    inputBreakdown,
  };
}

export function calculateInputCostBreakdown(
  breakdown: SummaryInputTokenBreakdown,
  inputPerMillion = config.llm.summarization.inputCostPerMillion
): SummaryInputCostBreakdown {
  const systemPromptCost =
    (breakdown.systemPromptTokens / 1_000_000) * inputPerMillion;
  const existingSummaryCost =
    (breakdown.existingSummaryTokens / 1_000_000) * inputPerMillion;
  const historyCost = (breakdown.historyTokens / 1_000_000) * inputPerMillion;

  return {
    systemPromptCost: roundCost(systemPromptCost),
    existingSummaryCost: roundCost(existingSummaryCost),
    historyCost: roundCost(historyCost),
    totalInputCost: roundCost(
      systemPromptCost + existingSummaryCost + historyCost
    ),
  };
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
