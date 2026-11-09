import { calculateLlmCost } from "../integrations/llm/cost/llm-cost-calculator";
import { SummaryGenerationResult } from "../integrations/llm/types";
import { RequestContext } from "../platform/context/request-context";
import { measureAsync } from "../platform/logger";
import {  
  CreateSummaryGenerationLogInput,
  SummaryGenerationLogRepository,
} from "./summary-generation-log.repository";

export class SummaryUsageService {
  private readonly repository = new SummaryGenerationLogRepository();

  async recordGeneration(
    conversationId: string,
    result: SummaryGenerationResult
  ): Promise<void> {
    const cost = result.cost ?? calculateLlmCost(result.usage);

    const input: CreateSummaryGenerationLogInput = {
      conversationId,
      userId: RequestContext.getUserId(),
      tenantId: RequestContext.getTenantId(),
      operation: result.operation,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      cost,
      inputTokenBreakdown: result.inputTokenBreakdown,
      inputCostBreakdown: result.inputCostBreakdown,
    };

    await measureAsync(
      "summary.usage.record",
      () => this.repository.create(input),
      {
        conversationId,
        operation: result.operation,
        totalTokens: result.usage.totalTokens,
        totalCost: cost.totalCost,
      }
    );
  }
}
