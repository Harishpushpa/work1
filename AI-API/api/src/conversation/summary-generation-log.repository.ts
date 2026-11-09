import { db } from "../platform/database";
import { summaryGenerationLogsTable } from "../platform/database/schema/summary-generation-logs.table";
import { SummaryOperation } from "../integrations/llm/types";
import { LlmCostBreakdown } from "../integrations/llm/cost/llm-cost-calculator";
import {
  SummaryInputCostBreakdown,
  SummaryInputTokenBreakdown,
  Usage,
} from "../integrations/llm/types";

export interface CreateSummaryGenerationLogInput {
  conversationId: string;
  userId?: string;
  tenantId?: string;
  operation: SummaryOperation;
  provider: string;
  model: string;
  usage: Usage;
  cost: LlmCostBreakdown;
  inputTokenBreakdown: SummaryInputTokenBreakdown;
  inputCostBreakdown: SummaryInputCostBreakdown;
}

export class SummaryGenerationLogRepository {
  async create(input: CreateSummaryGenerationLogInput): Promise<void> {
    await db.insert(summaryGenerationLogsTable).values({
      conversationId: input.conversationId,
      userId: input.userId,
      tenantId: input.tenantId,
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      totalTokens: input.usage.totalTokens,
      promptCost: String(input.cost.promptCost),
      completionCost: String(input.cost.completionCost),
      totalCost: String(input.cost.totalCost),
      inputTokenBreakdown: input.inputTokenBreakdown,
      inputCostBreakdown: input.inputCostBreakdown,
    });
  }
}
