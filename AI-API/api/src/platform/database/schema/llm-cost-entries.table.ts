import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const llmCostEntriesTable = pgTable("llm_cost_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id"),
  documentId: uuid("document_id"),
  clientId: varchar("client_id", { length: 100 }),
  operation: varchar("operation", { length: 50 }).notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  promptCost: numeric("prompt_cost", { precision: 12, scale: 6 }).notNull().default("0"),
  completionCost: numeric("completion_cost", { precision: 12, scale: 6 }).notNull().default("0"),
  totalCost: numeric("total_cost", { precision: 12, scale: 6 }).notNull().default("0"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

