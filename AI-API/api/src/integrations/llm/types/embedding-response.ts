export interface EmbeddingCost {
  totalTokens: number;
  totalCost: number;
  perInputTokens?: number[];
}

export interface EmbeddingResponse {
  vectors: number[][];
  cost?: EmbeddingCost;
}