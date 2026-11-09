import { config } from "../../../platform/config";

import { ChatProvider, EmbeddingProvider } from "../interfaces";

import { OllamaChatProvider } from "../providers/ollama/ollama-chat-provider";
import { OllamaEmbeddingProvider } from "../providers/ollama/ollama-embedding-provider";

export class LlmProviderFactory {

    static getChatProvider(): ChatProvider {

        return new OllamaChatProvider();

    }

    static getEmbeddingProvider(): EmbeddingProvider {
        return new OllamaEmbeddingProvider();
    }

}