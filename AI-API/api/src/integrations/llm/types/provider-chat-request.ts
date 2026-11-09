import { ChatMessage } from "./chat-message";
import { ChatOptions } from "./chat-options";

export interface ProviderChatRequest {
  conversationId?: string;
  model: string;
  messages: ChatMessage[];
  options?: ChatOptions;
}
