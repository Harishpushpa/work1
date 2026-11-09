import { eq } from "drizzle-orm";

import { db } from "../platform/database";

import { conversationSummaryTable } from "../platform/database/schema/conversation-summary.table";

export class ConversationSummaryRepository {

    async getSummary(
        conversationId: string
    ): Promise<string | null> {

        return await db.select()
            .from(conversationSummaryTable)
            .where(eq(conversationSummaryTable.conversationId, conversationId))
            .limit(1)
            .then(rows => rows[0]?.summary ?? null);

    }

    async saveSummary(
        conversationId: string,
        summary: string
    ): Promise<void> {

        const existing = await db.select()
            .from(conversationSummaryTable)
            .where(eq(conversationSummaryTable.conversationId, conversationId))
            .limit(1)
            .then(rows => rows[0] ?? null);

        if (existing) {

            await db
                .update(conversationSummaryTable)
                .set({

                    summary,

                    updatedAt: new Date(),

                })
                .where(
                    eq(
                        conversationSummaryTable.conversationId,
                        conversationId
                    )
                );

            return;

        }

        await db
            .insert(conversationSummaryTable)
            .values({

                conversationId,

                summary,

            });

    }

    async deleteSummary(
        conversationId: string
    ): Promise<void> {

        await db
            .delete(conversationSummaryTable)
            .where(
                eq(
                    conversationSummaryTable.conversationId,
                    conversationId
                )
            );

    }

    async listSummaries() {
        return db.select().from(conversationSummaryTable);
    }

}
