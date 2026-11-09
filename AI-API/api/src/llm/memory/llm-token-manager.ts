import {
  encodingForModel,
  getEncoding,
  Tiktoken,
  TiktokenModel,
} from "js-tiktoken";
import { ChatMessage } from "../../integrations/llm/types";

const MESSAGE_OVERHEAD_TOKENS = 4;

export class LlmTokenManager {
  private readonly encodingCache = new Map<string, Tiktoken>();

  countTokens(text: string, model: string): number {
    if (!text) {
      return 0;
    }

    return this.getEncoding(model).encode(text).length;
  }

  countSystemMessage(content: string, model: string): number {
    return this.countTokens(content, model) + MESSAGE_OVERHEAD_TOKENS;
  }

  countMessages(messages: ChatMessage[], model: string): number {
    return messages.reduce(
      (total, message) =>
        total + this.countTokens(message.content, model) + MESSAGE_OVERHEAD_TOKENS,
      0
    );
  }

  private getEncoding(model: string): Tiktoken {
    const cached = this.encodingCache.get(model);

    if (cached) {
      return cached;
    }

    let encoding: Tiktoken;

    try {
      encoding = encodingForModel(model as TiktokenModel);
    } catch {
      encoding = getEncoding("cl100k_base");
    }

    this.encodingCache.set(model, encoding);
    return encoding;
  }
}

export const llmTokenManager = new LlmTokenManager();
