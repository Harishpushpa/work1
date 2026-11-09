import { ChatResponse, ModelInfo, ProviderChatRequest } from "../types";

export interface ChatProvider {
    chat(request: ProviderChatRequest): Promise<ChatResponse>;

    listModels(): Promise<ModelInfo[]>;

    health(): Promise<boolean>;
}