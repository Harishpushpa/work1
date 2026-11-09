import {
    pgTable,
    uuid,
    varchar,
    text,
    integer,
    timestamp,
    jsonb,
} from "drizzle-orm/pg-core";

export const conversationMessageTable = pgTable("conversation_messages", {

    id: uuid("id")
        .primaryKey()
        .defaultRandom(),

    conversationId: uuid("conversation_id")
        .notNull(),

    role: varchar("role", { length: 20 })
        .notNull(),

    content: text("content")
        .notNull(),

    provider: varchar("provider", { length: 50 })
        .notNull(),

    model: varchar("model", { length: 100 })
        .notNull(),

    promptTokens: integer("prompt_tokens"),

    completionTokens: integer("completion_tokens"),

    totalTokens: integer("total_tokens"),

    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at")
        .defaultNow()
        .notNull(),

});