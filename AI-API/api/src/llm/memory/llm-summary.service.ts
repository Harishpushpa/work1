import { ChatMessage, SummaryGenerationResult } from "../../integrations/llm/types";
import {
  calculateInputCostBreakdown,
  calculateLlmCost,
} from "../../integrations/llm/cost/llm-cost-calculator";
import { SummaryInputTokenBreakdown } from "../../integrations/llm/types/summary-input-breakdown";
import { PromptManager } from "../prompts/prompt-manager";
import { config } from "../../platform/config/config";
import { LlmProviderFactory } from "../../integrations/llm/factory/chat-provider-factory";
import { llmTokenManager } from "./llm-token-manager";

export class LlmSummaryService {
  private readonly llmProvider = LlmProviderFactory.getChatProvider();

  shouldGenerateSummary(history: ChatMessage[]): boolean {
    return (
      history.reduce((acc, message) => acc + message.content.length, 0) >=
      config.llm.summarization.tokenThreshold
    );
  }

  async generateSummary(history: ChatMessage[]): Promise<SummaryGenerationResult> {
    const model = config.llm.summarization.model;
    const systemPrompt = PromptManager.getPrompt("summarization");
    const inputTokenBreakdown = this.buildGenerateInputBreakdown(
      systemPrompt,
      history,
      model
    );

    const response:any = await this.llmProvider.chat({
      model,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...history,
      ],
    });

    const usage = response.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    const inputCostBreakdown = calculateInputCostBreakdown(inputTokenBreakdown);

    return {
      summary: response.message.content,
      provider: response.provider,
      model: response.model,
      usage,
      cost: calculateLlmCost(usage, inputTokenBreakdown),
      operation: "generate",
      inputTokenBreakdown,
      inputCostBreakdown,
    };
  }

  async updateSummary(
    existingSummary: string,
    recentHistory: ChatMessage[]
  ): Promise<SummaryGenerationResult> {
    const model = config.llm.summarization.model;
    const systemPrompt = PromptManager.getPrompt("updatedSummarization");
    const historyContent = recentHistory
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");

    const inputTokenBreakdown = this.buildUpdateInputBreakdown(
      systemPrompt,
      existingSummary,
      historyContent,
      model
    );

    const response:any = await this.llmProvider.chat({
      model,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `Existing Summary

${existingSummary}

Recent Conversation

${historyContent}
`,
        },
      ],
      options:{maxTokens: config.llm.summarization.tokenThreshold},
    });

    const usage = response.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    const inputCostBreakdown = calculateInputCostBreakdown(inputTokenBreakdown);

    return {
      summary: response.message.content,
      provider: response.provider,
      model: response.model,
      usage,
      cost: calculateLlmCost(usage, inputTokenBreakdown),
      operation: "update",
      inputTokenBreakdown,
      inputCostBreakdown,
    };
  }

  private buildGenerateInputBreakdown(
    systemPrompt: string,
    history: ChatMessage[],
    model: string
  ): SummaryInputTokenBreakdown {
    const systemPromptTokens = llmTokenManager.countSystemMessage(
      systemPrompt,
      model
    );
    const historyTokens = llmTokenManager.countMessages(history, model);

    return {
      systemPromptTokens,
      existingSummaryTokens: 0,
      historyTokens,
      totalInputTokens: systemPromptTokens + historyTokens,
    };
  }

  private buildUpdateInputBreakdown(
    systemPrompt: string,
    existingSummary: string,
    historyContent: string,
    model: string
  ): SummaryInputTokenBreakdown {
    const systemPromptTokens = llmTokenManager.countSystemMessage(
      systemPrompt,
      model
    );
    const existingSummaryTokens =
      llmTokenManager.countTokens("Existing Summary\n\n", model) +
      llmTokenManager.countTokens(existingSummary, model);
    const historyTokens =
      llmTokenManager.countTokens("\n\nRecent Conversation\n\n", model) +
      llmTokenManager.countTokens(historyContent, model) +
      MESSAGE_OVERHEAD_TOKENS;

    return {
      systemPromptTokens,
      existingSummaryTokens,
      historyTokens,
      totalInputTokens:
        systemPromptTokens + existingSummaryTokens + historyTokens,
    };
  }
}

const MESSAGE_OVERHEAD_TOKENS = 4;
