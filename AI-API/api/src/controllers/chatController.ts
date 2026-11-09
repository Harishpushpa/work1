import { Request, Response } from "express";
import axios from "axios";
import { ConversationService } from "../conversation/conversation.service";
import { SaveConversationMessageRequest } from "../conversation/conversation.types";
import { LlmMemoryService } from "../llm/memory/llm-memory.service";
import { timedAsync } from "../platform/logger";
import { MemoryMaintenanceService } from "../llm/memory/memory-maintenance.service";
import {
  findDocRefByDocumentId,
  findLatestDocumentBySessionId,
  listTopFaqsByCategoryName,
} from "../pipeline/repository";

const HAYSTACK_CHAT_URL = process.env.HAYSTACK_CHAT_URL || "http://localhost:8000/chat";
const llmMemoryService = new LlmMemoryService();
const memoryMaintenanceService = new MemoryMaintenanceService();
const conversationService = new ConversationService();

/** First non-empty category token from LLM (may be comma-separated). */
function primaryCategory(raw: unknown): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  return text.split(",")[0]?.trim() || "";
}

export const handleChat = async (req: Request, res: Response) => {
  const body =
    (req.body as {
      message?: string;
      conversationId?: string;
      recent_messages?: Array<{ role?: string; content?: string }>;
      summary?: string | null;
      policy_number?: string | null;
      policy_name?: string | null;
      company_name?: string | null;
      insurer_name?: string | null;
      categories?: string | null;
    }) ?? undefined;

  if (!body || !body.message || typeof body.message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  try {
    // Persist user message if conversationId provided
    if (body.conversationId) {
      const userMsg: SaveConversationMessageRequest = {
        conversationId: body.conversationId,
        role: "user" as any,
        content: body.message,
        provider: "client",
        model: "unknown",
      };
      await conversationService.saveMessage(userMsg);
    }
    /** get recent messages from database or redis */
    const { result: history, durationMs: historyFetchMs } = await timedAsync(
      () => llmMemoryService.getHistory(body.conversationId || "")
    );
    history.push({
      role: "user",
      content: body.message,
    });
    
    // /** should get summary from Redis */
    let summary = await llmMemoryService.getSummary(body.conversationId || "");
    if (summary) {
      history.push({
        role: "system",
        content: `Conversation Summary: ${summary}`,
      });
    }

    const payload: {
      message: string;
      conversationId?: string;
      policy_number?: string | null;
      policy_name?: string | null;
      company_name?: string | null;
      insurer_name?: string | null;
      categories?: string | null;
      recent_messages?: Array<{ role?: string; content?: string }>;
      summary?: string | null;
    } = {
      message: body.message,
      conversationId: body.conversationId,
      policy_number: body.policy_number,
      policy_name: body.policy_name,
      company_name: body.company_name,
      insurer_name: body.insurer_name,
      categories: body.categories,
      recent_messages: history,
      summary: summary,
    };

    // Prefer stored interpret refs for the session document when the client
    // did not send policy scopes (chat retrieval filters).
    if (body.conversationId) {
      const document = await findLatestDocumentBySessionId(body.conversationId);
      if (document) {
        const docRef = await findDocRefByDocumentId(document.id);
        if (docRef) {
          if (!payload.policy_number) {
            payload.policy_number =
              docRef.policy_number || document.policy_id || null;
          }
          if (!payload.policy_name) payload.policy_name = docRef.policy_name;
          if (!payload.company_name) payload.company_name = docRef.company_name;
          if (!payload.insurer_name) payload.insurer_name = docRef.insurer_name;
          if (!payload.categories) payload.categories = docRef.categories;
        } else if (!payload.policy_number && document.policy_id) {
          payload.policy_number = document.policy_id;
        }
      }
    }

    const resp = await axios.post(HAYSTACK_CHAT_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 1200000,
    });
    const EMPTY_FALLBACK =
      "I don’t have enough information to provide an accurate answer.";
    let assistantContent = String(
      resp?.data?.answer ?? ""
    ).trim();
    if (!assistantContent) {
      assistantContent = EMPTY_FALLBACK;
      if (resp?.data && typeof resp.data === "object") {
        (resp.data as { answer?: string }).answer = assistantContent;
      }
    }

    // Persist assistant reply if conversationId provided (never store blank).
    if (body.conversationId) {
      const assistantMsg: SaveConversationMessageRequest = {
        conversationId: body.conversationId,
        role: "assistant" as any,
        content: assistantContent,
        provider: "haystack",
        model: resp?.data?.model ?? "haystack",
      };
      await conversationService.saveMessage(assistantMsg);
      history.push({
        role: "assistant",
        content: assistantContent,
      });
    }

    // When LLM returns a category, attach top-3 related FAQs for the session doc/policy.
    const category = primaryCategory(resp?.data?.category);
    let relatedFaqs: Array<{
      id: string;
      question: string;
      answer: string;
      category: string | null;
      documentId: string;
    }> = [];

    if (category && body.conversationId) {
      try {
        const doc = await findLatestDocumentBySessionId(body.conversationId);
        if (doc) {
          const policyId =
            (typeof resp?.data?.policy_number === "string" &&
              resp.data.policy_number.trim()) ||
            doc.policy_id ||
            body.policy_number ||
            null;
          const rows = await listTopFaqsByCategoryName({
            documentId: doc.id,
            categoryName: category,
            policyId,
            limit: 3,
          });
          relatedFaqs = rows.map((f) => ({
            id: f.id,
            question: f.question,
            answer: f.answer,
            category: f.category_name ?? category,
            documentId: f.document_id,
          }));
          console.log(
            `[chat] relatedFaqs category=${category} doc=${doc.id} n=${relatedFaqs.length}`
          );
        }
      } catch (faqErr) {
        console.warn(
          "[chat] relatedFaqs lookup failed:",
          faqErr instanceof Error ? faqErr.message : faqErr
        );
      }
    }

    // Run memory maintenance (persisting to Redis / summaries) in the background
    // so we can respond to the client without waiting. Log any errors.
    void memoryMaintenanceService
      .process(body.conversationId || "", history)
      .catch((err) => {
        console.error("memoryMaintenanceService.process (background) failed:", err);
      });

    const data =
      resp?.data && typeof resp.data === "object"
        ? { ...resp.data, relatedFaqs }
        : { answer: assistantContent, relatedFaqs };

        console.log("len of relatedFaqs", relatedFaqs.length);
        console.log("relatedFaqs", relatedFaqs);


    return res.status(resp.status).json(data);
  } catch (err: any) {
    const cause = err?.cause ?? err?.originalError ?? null;
    const pgCode = err?.code ?? cause?.code ?? null;
    const pgDetail = err?.detail ?? cause?.detail ?? cause?.message ?? null;
    const msg = err?.message || "chat proxy failed";
    const status = err?.response?.status || 500;
    const data = err?.response?.data;
    console.error("Haystack chat proxy error:", {
      message: msg,
      status,
      pgCode,
      pgDetail,
      axiosData: data ?? null,
    });
    return res.status(status).json({
      error: msg,
      detail: pgDetail || data || null,
      code: pgCode,
    });
  }
};
