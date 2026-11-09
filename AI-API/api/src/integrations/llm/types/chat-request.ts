import { ChatMessage } from "./chat-message";
import { ChatOptions } from "./chat-options";

export interface ChatRequest {
  conversationId: string;
  intent?: {
    type: "KNOWLEDGE" | "AGENT" | "OTHER" | "GREETING";
    agentId?: string;
  };
  model: string;
  // Optional explicit provider (e.g. "openai", "ollama", "gemini").
  provider?: string;
  embeddingProvider?: string;
  embeddingModel?: string;
  message: string;
  // The client identifier is required for multi-tenant knowledge scoping.
  clientId: string;
  // Optional list of knowledge base IDs to restrict retrieval.
  // Use ["all"] to indicate "all knowledge bases for this client".
  knowledgeBases?: string[];
  options?: ChatOptions;
}
