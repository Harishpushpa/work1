import {
    pgTable,
    uuid,
    text,
    timestamp,
} from "drizzle-orm/pg-core";

export const conversationSummaryTable = pgTable(
    "conversation_summaries",
    {

        conversationId: uuid("conversation_id")
            .primaryKey(),

        summary: text("summary")
            .notNull(),

        createdAt: timestamp("created_at")
            .defaultNow()
            .notNull(),

        updatedAt: timestamp("updated_at")
            .defaultNow()
            .notNull(),

    }
);