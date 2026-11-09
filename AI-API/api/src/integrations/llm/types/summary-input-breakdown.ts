export interface SummaryInputTokenBreakdown {
  systemPromptTokens: number;
  existingSummaryTokens: number;
  historyTokens: number;
  totalInputTokens: number;
}

export interface SummaryInputCostBreakdown {
  systemPromptCost: number;
  existingSummaryCost: number;
  historyCost: number;
  totalInputCost: number;
}
