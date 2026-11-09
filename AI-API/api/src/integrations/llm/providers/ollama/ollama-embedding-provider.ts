import {
  EmbeddingProvider,
} from "../../interfaces";

import {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelInfo,
} from "../../types";

/** Embeddings via Haystack POST /embed — model from haystack EMBEDDING_* unless overridden. */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl = (
    process.env.HAYSTACK_EMBED_URL ||
    process.env.EMBED_URL ||
    "http://127.0.0.1:8000/embed"
  ).replace(/\/$/, "");

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const texts = Array.isArray(request.input)
      ? request.input.map((t) => String(t ?? ""))
      : [String(request.input ?? "")];
    const model =
      request.model?.trim() ||
      process.env.INGEST_EMBEDDING_MODEL?.trim() ||
      process.env.EMBEDDING_MODEL?.trim() ||
      undefined;

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(model ? { texts, model } : { texts }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Haystack embed failed (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as {
      embeddings?: number[][];
    };

    return {
      vectors: data.embeddings ?? [],
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const id =
      process.env.INGEST_EMBEDDING_MODEL?.trim() ||
      process.env.EMBEDDING_MODEL?.trim() ||
      "haystack-configured";
    return [
      {
        id,
        name: id,
        provider: "haystack",
        supportsChat: false,
        supportsEmbedding: true,
        supportsVision: false,
      },
    ];
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
