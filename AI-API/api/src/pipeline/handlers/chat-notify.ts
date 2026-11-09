import { ConversationService } from '../../conversation/conversation.service';
import { LlmMemoryService } from '../../llm/memory/llm-memory.service';
import {
  addEvent,
  getDocument,
  getFullSummary,
  getTopFaqCategories,
  hasPostedDocumentFaqCategories,
  hasPostedDocumentFullSummary,
  type FaqCategoryCount,
} from '../repository';
import type { DocumentId } from '../types';

const conversationService = new ConversationService();
const llmMemoryService = new LlmMemoryService();

function formatFullSummaryMessage(opts: {
  fileName: string | null;
  summary: string;
}): string {
  const name = (opts.fileName || 'your document').trim();
  return (
    `Here's an overview :\n\n` +
    `${opts.summary.trim()}`
  );
}

function formatFaqCategoriesMessage(categories: FaqCategoryCount[]): string {
  const lines = categories.map(
    (c) =>
      `• ${c.name} (${c.questionCount} question${c.questionCount === 1 ? '' : 's'})`
  );
  return (
    `Here are popular topics for this policy. ` +
    `Tap a topic to see related questions, or type any question you like — optional.\n\n` +
    lines.join('\n')
  );
}

async function clearHistorySafe(sessionId: string, label: string): Promise<void> {
  try {
    await llmMemoryService.clearHistory(sessionId);
  } catch (err) {
    console.warn(
      `[chat-notify] clearHistory failed after ${label} (message still in Postgres):`,
      (err as Error)?.message || err
    );
  }
}

export type ChatNotifyOpts = {
  /** Override documents.session_id (customer upload reuse into a new chat). */
  sessionId?: string | null;
  /** Post even if this session already received the message. */
  force?: boolean;
};

/**
 * After pipeline completes: post the document's `type=full` summary into the
 * chat session linked via documents.session_id (widget conversation id).
 * Section summaries are not posted.
 */
export async function postFullSummaryToUserChat(
  documentId: DocumentId,
  opts: ChatNotifyOpts = {}
): Promise<{ posted: boolean; reason?: string }> {
  const doc = await getDocument(documentId);
  if (!doc) {
    return { posted: false, reason: 'document_missing' };
  }

  const sessionId = (opts.sessionId || doc.session_id || '').trim();
  if (!sessionId) {
    return { posted: false, reason: 'no_session' };
  }

  if (
    !opts.force &&
    (await hasPostedDocumentFullSummary(sessionId, documentId))
  ) {
    return { posted: false, reason: 'already_posted' };
  }

  const full = await getFullSummary(documentId);
  if (!full?.summary?.trim()) {
    console.warn(
      `[chat-notify] no type=full summary for doc=${documentId} session=${sessionId}`
    );
    return { posted: false, reason: 'no_full_summary' };
  }

  const content = formatFullSummaryMessage({
    fileName: doc.file_name,
    summary: full.summary,
  });

  await conversationService.saveMessage({
    conversationId: sessionId,
    role: 'assistant' as any,
    content,
    provider: 'pipeline',
    model: 'document-full-summary',
    metadata: {
      source: 'document_full_summary',
      documentId: String(documentId),
      summaryType: 'full',
      version: full.version,
    },
  });

  await clearHistorySafe(sessionId, 'full summary');

  await addEvent(
    documentId,
    'completed',
    `Posted full document summary to chat session ${sessionId}`,
    { sessionId, version: full.version }
  );

  console.log(
    `[chat-notify] posted full summary doc=${documentId} session=${sessionId} chars=${content.length}`
  );

  return { posted: true };
}

/**
 * After the full summary: post top-3 FAQ categories (with question counts)
 * as a follow-up assistant message with selectable single-choice chips.
 * Skipped when the document has zero FAQs or no categorized FAQs.
 */
export async function postFaqCategoriesToUserChat(
  documentId: DocumentId,
  opts: ChatNotifyOpts = {}
): Promise<{ posted: boolean; reason?: string }> {
  const doc = await getDocument(documentId);
  if (!doc) {
    return { posted: false, reason: 'document_missing' };
  }

  const sessionId = (opts.sessionId || doc.session_id || '').trim();
  if (!sessionId) {
    return { posted: false, reason: 'no_session' };
  }

  if (
    !opts.force &&
    (await hasPostedDocumentFaqCategories(sessionId, documentId))
  ) {
    return { posted: false, reason: 'already_posted' };
  }

  const categories = await getTopFaqCategories(documentId, 3);
  if (categories.length === 0) {
    console.warn(
      `[chat-notify] no active FAQ categories for doc=${documentId} session=${sessionId}`
    );
    return { posted: false, reason: 'no_faqs' };
  }

  const policyId = (doc.policy_id || '').trim() || null;
  const content = formatFaqCategoriesMessage(categories);
  const choices = categories.map((c) => ({
    id: c.id,
    kind: 'category' as const,
    label: `${c.name} (${c.questionCount})`,
    value: c.name,
    category: c.name,
    categoryId: c.id,
    questionCount: c.questionCount,
  }));

  await conversationService.saveMessage({
    conversationId: sessionId,
    role: 'assistant' as any,
    content,
    provider: 'pipeline',
    model: 'document-faq-categories',
    metadata: {
      source: 'document_faq_categories',
      documentId: String(documentId),
      ...(policyId ? { policyId } : {}),
      selectionMode: 'single',
      optional: true,
      choices,
    },
  });

  await clearHistorySafe(sessionId, 'faq categories');

  await addEvent(
    documentId,
    'completed',
    `Posted FAQ category chips to chat session ${sessionId}`,
    {
      sessionId,
      categories: categories.map((c) => ({
        name: c.name,
        questionCount: c.questionCount,
      })),
    }
  );

  console.log(
    `[chat-notify] posted faq categories doc=${documentId} session=${sessionId} n=${categories.length}`
  );

  return { posted: true };
}

/**
 * Customer upload hit a completed doc (same hash + policy): reuse artifacts and
 * post summary into the current chat session (user flow has no FAQs).
 */
export async function notifyCustomerReuseToChat(
  documentId: DocumentId,
  sessionId: string
): Promise<{
  summaryPosted: boolean;
  summaryReason?: string;
}> {
  // force=false: skip if this session already got the messages; new sessions always post.
  const summary = await postFullSummaryToUserChat(documentId, { sessionId });
  return {
    summaryPosted: summary.posted,
    summaryReason: summary.reason,
  };
}
