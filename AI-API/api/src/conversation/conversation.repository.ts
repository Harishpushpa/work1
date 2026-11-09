import { randomUUID } from "crypto";

import pool from "../db";
import { measureAsync } from "../platform/logger";
import { SaveConversationMessageRequest } from "./conversation.types";

function pgErrorFields(err: unknown): Record<string, unknown> {
  const e = err as {
    message?: string;
    code?: string;
    detail?: string;
    hint?: string;
    severity?: string;
    cause?: unknown;
  };
  const cause = e?.cause as { message?: string; code?: string; detail?: string } | undefined;
  return {
    message: e?.message,
    code: e?.code ?? cause?.code,
    detail: e?.detail ?? cause?.detail,
    hint: e?.hint,
    severity: e?.severity,
    causeMessage: cause?.message,
  };
}

export class ConversationRepository {
  async getMessages(conversationId: string): Promise<any[]> {
    return measureAsync(
      "conversation.getMessages",
      async () => {
        const { rows } = await pool.query(
          `SELECT role, content, metadata
           FROM conversation_messages
           WHERE conversation_id = $1
           ORDER BY created_at ASC`,
          [conversationId]
        );

        return rows.map((message) => ({
          role: message.role as any,
          content: message.content,
          metadata: message.metadata ?? undefined,
        }));
      },
      { conversationId }
    );
  }

  async saveMessage(request: SaveConversationMessageRequest): Promise<void> {
    return measureAsync(
      "conversation.saveMessage",
      async () => {
        const id = randomUUID();
        const metadata =
          request.metadata && Object.keys(request.metadata).length > 0
            ? {
                ...request.metadata,
                cost: (request as any).cost ?? undefined,
              }
            : (request as any).cost
              ? { cost: (request as any).cost }
              : request.metadata ?? null;

        try {
          await pool.query(
            `INSERT INTO conversation_messages (
               id, conversation_id, role, content, provider, model,
               prompt_tokens, completion_tokens, total_tokens, metadata, created_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW()
             )`,
            [
              id,
              request.conversationId,
              request.role,
              request.content,
              request.provider,
              request.model,
              request.usage?.promptTokens ?? null,
              request.usage?.completionTokens ?? null,
              request.usage?.totalTokens ?? null,
              metadata == null ? null : JSON.stringify(metadata),
            ]
          );
        } catch (err) {
          console.error(
            "[conversation.saveMessage] insert failed",
            pgErrorFields(err),
            {
              conversationId: request.conversationId,
              role: request.role,
            }
          );
          throw err;
        }
      },
      {
        conversationId: request.conversationId,
        role: request.role,
      }
    );
  }

  async deleteMessages(conversationId: string): Promise<void> {
    return measureAsync(
      "conversation.deleteMessages",
      async () => {
        await pool.query(
          `DELETE FROM conversation_messages WHERE conversation_id = $1`,
          [conversationId]
        );
      },
      { conversationId }
    );
  }
}
