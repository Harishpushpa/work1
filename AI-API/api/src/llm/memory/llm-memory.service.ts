import { ChatMessage } from "../../integrations/llm/types";

import { ConversationService } from "../../conversation/conversation.service";
import { ConversationSummaryRepository } from "../../conversation/conversation-summary.repository";

import { RequestContext } from "../../platform/context/request-context";
import { redisClient } from "../../platform/cache/redis.client";
import { config } from "../../platform/config";
import { logger, measureAsync } from "../../platform/logger";

export class LlmMemoryService {

    private readonly conversationService =
        new ConversationService();

    private readonly summaryRepository =
        new ConversationSummaryRepository();

    private getHistoryCacheKey(
        conversationId: string
    ): string {

        return `conversation:${conversationId}:history`;

    }

    private getSummaryCacheKey(
        conversationId: string
    ): string {

        return `conversation:${conversationId}:summary`;

    }

    async getHistory(
        conversationId: string
    ): Promise<ChatMessage[]> {
        console.log("conversationId", conversationId);
        return measureAsync(

            "llm.memory.getHistory",

            async () => {

                const cached = await redisClient.get(
                    this.getHistoryCacheKey(conversationId)
                );
                console.log("cached", cached);
                if (cached) {

                    const history =
                        JSON.parse(cached) as ChatMessage[];

                    logger.info(
                        {
                            requestId: RequestContext.getRequestId(),
                            conversationId,
                            source: "redis",
                            messageCount: history.length,
                        },
                        "Conversation history loaded from Redis"
                    );

                    return history;

                }

                const history =
                    await this.conversationService.getMessages(
                        conversationId
                    );

                const recentHistory = history.slice(
                    -config.redis.historyLimit
                );

                await redisClient.set(
                    this.getHistoryCacheKey(conversationId),
                    JSON.stringify(recentHistory),
                    {
                        EX: config.redis.historyCacheTtl,
                    }
                );

                logger.info(
                    {
                        requestId: RequestContext.getRequestId(),
                        conversationId,
                        source: "postgres",
                        messageCount: recentHistory.length,
                    },
                    "Conversation history loaded from PostgreSQL"
                );

                return recentHistory;

            },

            {
                conversationId,
            }

        );

    }

    async saveHistory(
        conversationId: string,
        history: ChatMessage[]
    ): Promise<void> {

        const recentHistory = history.slice(
            -config.redis.historyLimit
        );

        await redisClient.set(
            this.getHistoryCacheKey(conversationId),
            JSON.stringify(recentHistory),
            {
                EX: config.redis.historyCacheTtl,
            }
        );

    }

    async clearHistory(
        conversationId: string
    ): Promise<void> {

        await redisClient.del(
            this.getHistoryCacheKey(conversationId)
        );

    }

    async getSummary(
        conversationId: string
    ): Promise<string | null> {

        const cached = await redisClient.get(
            this.getSummaryCacheKey(conversationId)
        );

        if (cached) {

            logger.info(
                {
                    requestId: RequestContext.getRequestId(),
                    conversationId,
                    source: "redis",
                },
                "Conversation summary loaded from Redis"
            );

            return cached;

        }

        const summary =
            await this.summaryRepository.getSummary(
                conversationId
            );

        if (!summary) {

            return null;

        }

        await redisClient.set(
            this.getSummaryCacheKey(conversationId),
            summary,
            {
                EX: config.redis.historyCacheTtl,
            }
        );

        logger.info(
            {
                requestId: RequestContext.getRequestId(),
                conversationId,
                source: "postgres",
            },
            "Conversation summary loaded from PostgreSQL"
        );

        return summary;

    }

    async saveSummary(
        conversationId: string,
        summary: string
    ): Promise<void> {

        await Promise.all([

            this.summaryRepository.saveSummary(
                conversationId,
                summary
            ),

            redisClient.set(
                this.getSummaryCacheKey(conversationId),
                summary,
                {
                    EX: config.redis.historyCacheTtl,
                }
            )

        ]);

    }

    async clearSummary(
        conversationId: string
    ): Promise<void> {

        await Promise.all([

            this.summaryRepository.deleteSummary(
                conversationId
            ),

            redisClient.del(
                this.getSummaryCacheKey(conversationId)
            )

        ]);

    }

}