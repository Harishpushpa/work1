import { db } from "../../database";
import { llmCostEntriesTable } from "./llm-cost-entries.table";

export interface CreateLlmCostEntryInput {
  conversationId?: string | null;
  documentId?: string | null;
  clientId?: string | null;
  operation: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCost: number;
  completionCost: number;
  totalCost: number;
  metadata?: Record<string, unknown>;
}

export class LlmCostRepository {
  async create(input: CreateLlmCostEntryInput): Promise<void> {
    await db.insert(llmCostEntriesTable).values({
      conversationId: input.conversationId ?? null,
      documentId: input.documentId ?? null,
      clientId: input.clientId ?? null,
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      promptCost: String(input.promptCost),
      completionCost: String(input.completionCost),
      totalCost: String(input.totalCost),
      metadata: input.metadata,
    });
  }
}

export default new LlmCostRepository();

