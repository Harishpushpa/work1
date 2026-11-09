import { Usage } from "./usage";
import { LlmCostBreakdown } from "../cost/llm-cost-calculator";
import {
  SummaryInputCostBreakdown,
  SummaryInputTokenBreakdown,
} from "./summary-input-breakdown";

export type SummaryOperation = "generate" | "update";

export interface SummaryGenerationResult {
  summary: string;
  provider: string;
  model: string;
  usage: Usage;
  cost: LlmCostBreakdown;
  operation: SummaryOperation;
  inputTokenBreakdown: SummaryInputTokenBreakdown;
  inputCostBreakdown: SummaryInputCostBreakdown;
}
