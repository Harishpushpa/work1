import { ChatMessage } from "../../integrations/llm/types";

import { LlmMemoryService } from "./llm-memory.service";
import { LlmSummaryService } from "./llm-summary.service";
import { SummaryUsageService } from "../../conversation/summary-usage.service";
import llmCostRepo from "../../platform/database/schema/llm-cost.repository";

export class MemoryMaintenanceService {
  private readonly memoryService = new LlmMemoryService();
  private readonly summaryService = new LlmSummaryService();
  private readonly usageService = new SummaryUsageService();

  async process(conversationId: string, history: ChatMessage[]): Promise<void> {
    await this.memoryService.saveHistory(conversationId, history);

    if (!this.summaryService.shouldGenerateSummary(history)) {
      return;
    }
    const existingSummary = await this.memoryService.getSummary(conversationId);
    const result = existingSummary
      ? await this.summaryService.updateSummary(existingSummary, history)
      : await this.summaryService.generateSummary(history);
    await this.memoryService.saveSummary(conversationId, result.summary);
    await this.usageService.recordGeneration(conversationId, result);
    // Persist summarization cost into llm_cost_entries
    try {
      if (result && result.usage) {
        const cost = result.cost;
        await llmCostRepo.create({
          conversationId,
          documentId: null,
          clientId: null,
          operation: "summarization",
          provider: result.provider,
          model: result.model,
          promptTokens: result.usage.promptTokens ?? 0,
          completionTokens: result.usage.completionTokens ?? 0,
          totalTokens: result.usage.totalTokens ?? 0,
          promptCost: cost?.promptCost ?? 0,
          completionCost: cost?.completionCost ?? 0,
          totalCost: cost?.totalCost ?? 0,
          metadata: { source: "summary_generation" },
        });
      }
    } catch (err) {
      // don't block main flow
      console.warn("Failed to persist summarization cost:", err);
    }
  }
}
