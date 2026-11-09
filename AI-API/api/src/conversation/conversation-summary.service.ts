import { LlmCostBreakdown } from "../integrations/llm/cost/llm-cost-calculator";
import {
  SummaryInputCostBreakdown,
  SummaryInputTokenBreakdown,
  Usage,
} from "../integrations/llm/types";
import { LlmMemoryService } from "../llm/memory/llm-memory.service";
import { LlmSummaryService } from "../llm/memory/llm-summary.service";
import { ConversationSummaryRepository } from "./conversation-summary.repository";
import { SummaryUsageService } from "./summary-usage.service";

export interface ConversationSummary {
  conversationId: string;
  summary: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GenerateSummaryResult {
  conversationId: string;
  summary: string;
  isUpdate: boolean;
  usage: Usage;
  cost: LlmCostBreakdown;
  inputTokenBreakdown: SummaryInputTokenBreakdown;
  inputCostBreakdown: SummaryInputCostBreakdown;
}

export class ConversationSummaryService {
  private readonly repository = new ConversationSummaryRepository();
  private readonly memoryService = new LlmMemoryService();
  private readonly summaryService = new LlmSummaryService();
  private readonly usageService = new SummaryUsageService();

  async listSummaries(): Promise<ConversationSummary[]> {
    return this.repository.listSummaries();
  }

  async generateSummary(
    conversationId: string
  ): Promise<GenerateSummaryResult> {
    const history = await this.memoryService.getHistory(conversationId);

    if (history.length === 0) {
      throw new Error("No conversation history found to summarize");
    }

    const existingSummary = await this.memoryService.getSummary(conversationId);
    const result = existingSummary
      ? await this.summaryService.updateSummary(existingSummary, history)
      : await this.summaryService.generateSummary(history);

    await this.memoryService.saveSummary(conversationId, result.summary);
    await this.usageService.recordGeneration(conversationId, result);

    return {
      conversationId,
      summary: result.summary,
      isUpdate: result.operation === "update",
      usage: result.usage,
      cost: result.cost,
      inputTokenBreakdown: result.inputTokenBreakdown,
      inputCostBreakdown: result.inputCostBreakdown,
    };
  }

  async deleteSummary(conversationId: string): Promise<void> {
    await this.memoryService.clearSummary(conversationId);
  }
}
