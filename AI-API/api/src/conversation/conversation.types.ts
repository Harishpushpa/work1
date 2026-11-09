import { ChatMessage, ChatRole, Usage } from "../integrations/llm/types";
export interface SaveConversationMessageRequest {
    conversationId: string;
    role: ChatRole;
    content: string;
    provider: string;
    model: string;
    usage?: Usage;
    metadata?: Record<string, unknown>;
}

export interface ConversationMessage {
    id: string;
    conversationId: string;
    role: ChatRole;
    content: string;
    provider: string;
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    metadata?: Record<string, unknown>;
    createdAt: Date;
}

export interface GetConversationMessagesRequest {
    conversationId: string;
}

export interface GetConversationMessagesResponse {
    messages: ChatMessage[];
}
