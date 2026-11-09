import { NextFunction, Request, Response } from "express";

import { ConversationService } from "./conversation.service";
import { ConversationSummaryService } from "./conversation-summary.service";
import { LlmMemoryService } from "../llm/memory/llm-memory.service";
import { ResponseBuilder } from "../platform/response";
import { ChatRole } from "../integrations/llm/types";
import { SaveConversationMessageRequest } from "./conversation.types";

export class ConversationController {

    private readonly conversationService = new ConversationService();
    private readonly conversationSummaryService = new ConversationSummaryService();
    private readonly llmMemoryService = new LlmMemoryService();

    async getMessages(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {

        try {

            const { conversationId } = req.params;

            const messages = await this.conversationService.getMessages(
                conversationId as string
            );

            ResponseBuilder.success(res, messages);

        } catch (error) {

            next(error);

        }

    }

    /**
     * POST dispatcher: `{ messages: [...] }` → append; `{ role, content }` → single save.
     */
    async postMessages(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        if (Array.isArray(req.body?.messages)) {
            return this.appendMessages(req, res, next);
        }
        return this.saveMessage(req, res, next);
    }

    /**
     * Append one or more messages (e.g. FAQ category → questions → answer)
     * without calling the LLM. Clears Redis history so the next chat turn
     * reloads from Postgres.
     */
    async appendMessages(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const { conversationId } = req.params;
            const raw = Array.isArray(req.body?.messages)
                ? req.body.messages
                : req.body?.content
                  ? [req.body]
                  : [];

            if (!conversationId || raw.length === 0) {
                res.status(400).json({
                    success: false,
                    message: "conversationId and messages are required",
                });
                return;
            }

            for (const item of raw) {
                const role = String(item.role || "").trim();
                const content = String(item.content || "").trim();
                if (
                    !content ||
                    (role !== "user" && role !== "assistant" && role !== "system")
                ) {
                    res.status(400).json({
                        success: false,
                        message: "Each message needs role (user|assistant|system) and content",
                    });
                    return;
                }

                await this.conversationService.saveMessage({
                    conversationId: conversationId as string,
                    role: role as any,
                    content,
                    provider: String(item.provider || "widget"),
                    model: String(item.model || "faq-browse"),
                    metadata:
                        item.metadata && typeof item.metadata === "object"
                            ? item.metadata
                            : undefined,
                });
            }

            try {
                await this.llmMemoryService.clearHistory(conversationId as string);
            } catch {
                /* message(s) still in Postgres */
            }

            ResponseBuilder.created(res, { appended: raw.length }, "Messages appended");
        } catch (error) {
            next(error);
        }
    }

    async deleteMessages(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {

        try {

            const { conversationId } = req.params;

            await this.conversationService.deleteMessages(
                conversationId as string
            );

            ResponseBuilder.success(res, "Conversation messages deleted successfully");

        } catch (error) {

            next(error);

        }

    }

    async listSummaries(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const summaries = await this.conversationSummaryService.listSummaries();
            ResponseBuilder.success(res, summaries, "Conversation summaries fetched successfully");
        } catch (error) {
            next(error);
        }
    }

    async deleteSummary(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const { conversationId } = req.params;
            await this.conversationSummaryService.deleteSummary(conversationId as string);
            ResponseBuilder.success(res, "Conversation summary deleted successfully");
        } catch (error) {
            next(error);
        }
    }

    async generateSummary(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const { conversationId } = req.params;
            const result = await this.conversationSummaryService.generateSummary(
                conversationId as string
            );
            ResponseBuilder.success(
                res,
                result,
                result.isUpdate
                    ? "Conversation summary updated successfully"
                    : "Conversation summary generated successfully"
            );
        } catch (error) {
            next(error);
        }
    }

    async saveMessage(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const { conversationId } = req.params;
            const payload = req.body as {
                role: ChatRole;
                content: string;
                provider?: string;
                model?: string;
                usage?: SaveConversationMessageRequest["usage"];
                metadata?: Record<string, unknown>;
            };

            if (
                !payload ||
                typeof payload.content !== "string" ||
                !String(payload.content).trim() ||
                !payload.role
            ) {
                res.status(400).json({
                    success: false,
                    message: "role and content are required",
                });
                return;
            }

            const saveReq: SaveConversationMessageRequest = {
                conversationId: conversationId as string,
                role: payload.role,
                content: payload.content,
                provider: payload.provider || "client",
                model: payload.model || "unknown",
                usage: payload.usage,
                metadata: payload.metadata,
            };

            await this.conversationService.saveMessage(saveReq);

            ResponseBuilder.success(res, "Message saved");
        } catch (error) {
            next(error);
        }
    }

}
