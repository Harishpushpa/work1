import {
    EmbeddingRequest,
    EmbeddingResponse,
    ModelInfo,
} from "../types";

export interface EmbeddingProvider {
    embed(
        request: EmbeddingRequest
    ): Promise<EmbeddingResponse>;

    listModels(): Promise<ModelInfo[]>;

    health(): Promise<boolean>;
}