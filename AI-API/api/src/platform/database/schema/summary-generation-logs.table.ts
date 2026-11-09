import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const summaryGenerationLogsTable = pgTable("summary_generation_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  userId: varchar("user_id", { length: 100 }),
  tenantId: varchar("tenant_id", { length: 100 }),
  operation: varchar("operation", { length: 20 }).notNull(),
  provider: varchar("provider", { length: 50 }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  promptCost: numeric("prompt_cost", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  completionCost: numeric("completion_cost", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  totalCost: numeric("total_cost", { precision: 12, scale: 6 })
    .notNull()
    .default("0"),
  inputTokenBreakdown: jsonb("input_token_breakdown"),
  inputCostBreakdown: jsonb("input_cost_breakdown"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
