import { ChatProvider } from "../../interfaces";
import { ChatResponse, ModelInfo, ProviderChatRequest } from "../../types";

export class OllamaChatProvider implements ChatProvider {
    private readonly baseUrl =
    process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

    async chat(request: ProviderChatRequest): Promise<any> {
        console.log(
          `[LLM] provider=ollama model=${request.model} url=${this.baseUrl}/api/chat`
        );
        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: request.model,
              messages: request.messages,
              stream: false,
              options: {
                num_ctx: 32768,
                num_predict: -1,
              },
            }),
          });
      
          if (!response.ok) {
            const errorText = await response.text();
      
            throw new Error(
              `Ollama chat failed (${response.status}): ${errorText}`
            );
          }
      
          const data = await response.json();
      
          return {
            content: data.message?.content ?? "",
            model: data.model ?? request.model,
            provider: "ollama",
            message: data.message ?? null,
            usage: {
              promptTokens: data.prompt_eval_count ?? 0,
              completionTokens: data.eval_count ?? 0,
              totalTokens:
                (data.prompt_eval_count ?? 0) +
                (data.eval_count ?? 0),
            },
          };
    }

    async listModels(): Promise<ModelInfo[]> {
        throw new Error("Not implemented");
    }

    async health(): Promise<boolean> {
        throw new Error("Not implemented");
    }

}