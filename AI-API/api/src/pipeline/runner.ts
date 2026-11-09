import { pipelineConfig } from './config';
import { resolveDocumentFilePath } from './files';
import { postFullSummaryToUserChat } from './handlers/chat-notify';
import { runExtractSteps } from './handlers/extract';
import { runFaqSteps } from './handlers/faqs';
import {
  isInvalidDocumentInterpretation,
  runPolicyRefs,
} from './handlers/policy-refs';
import { runSummarySteps } from './handlers/summaries';
import { runVectorIndex } from './handlers/vector';
import {
  activateFaqsForDocument,
  addEvent,
  claimDocument,
  countFaqs,
  countSummaries,
  getDocument,
  getPolicyRefs,
  hasDonePages,
  isStepDone,
  markFailed,
  markPermanentlyFailed,
  setPipelineStep,
  touchHeartbeat,
} from './repository';
import type {
  DocumentId,
  PipelineStep,
  ProcessDocumentJobData,
  StepContext,
} from './types';
import { sourceNeedsFaqs, sourceNeedsSummaries } from './types';

/** Thrown after markPermanentlyFailed — catch must not re-queue via markFailed. */
class PermanentPipelineError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentPipelineError';
  }
}

export type ProgressUpdater = (progress: {
  step: PipelineStep;
  percent: number;
  message?: string;
}) => Promise<void>;

/**
 * Role-based pipeline:
 * - customer: uploaded → layout/pages → policy_refs → vector → summaries → completed (no FAQs)
 * - admin / folder: same flow with FAQs; skips summary generation (and chat summary notify)
 */
export async function runDocumentPipeline(
  data: ProcessDocumentJobData,
  updateProgress: ProgressUpdater
): Promise<{ documentId: DocumentId; chatReady: boolean; status: string }> {
  const claimed = await claimDocument(data.documentId);
  if (!claimed) {
    const existing = await getDocument(data.documentId);
    const { UnrecoverableError } = await import('bullmq');
    // Missing / deleted docs must not retry forever in BullMQ.
    if (!existing) {
      throw new UnrecoverableError(
        `Document ${data.documentId} not found (deleted or never persisted)`
      );
    }
    if (existing.pipeline_status === 'completed') {
      return {
        documentId: data.documentId,
        chatReady: existing.chat_ready,
        status: 'completed',
      };
    }
    // Permanent — don't burn BullMQ attempts on unclaimable docs
    throw new UnrecoverableError(
      `Document ${data.documentId} could not be claimed (status=${existing.pipeline_status}, retries=${existing.retry_count}/${existing.retry_limit})`
    );
  }

  // Prefer shared files.storage_path over denormalized documents.location.
  const resolvedPath = await resolveDocumentFilePath(claimed);
  const ctx: StepContext = {
    documentId: claimed.id,
    location: resolvedPath || claimed.location,
    source: claimed.source,
    updateProgress,
  };

  let currentStep: PipelineStep = 'uploaded';
  const heartbeat = setInterval(() => {
    touchHeartbeat(ctx.documentId).catch((err) => {
      console.error('heartbeat failed', ctx.documentId, err?.message || err);
    });
  }, pipelineConfig.heartbeatIntervalMs);

  try {
    await touchHeartbeat(ctx.documentId);
    const resumeFrom = claimed.pipeline_step || 'uploaded';
    await addEvent(ctx.documentId, resumeFrom, 'Pipeline started / resumed', {
      source: ctx.source,
      resumeFrom,
      retryCount: claimed.retry_count,
    });
    console.log(
      `[pipeline] doc=${ctx.documentId} source=${ctx.source} ` +
        `resumeFrom=${resumeFrom} retry=${claimed.retry_count}/${claimed.retry_limit}`
    );
    await updateProgress({ step: 'uploaded', percent: 5 });

    let extractPayload: {
      document: Record<string, unknown>;
      elements: unknown[];
    } = { document: {}, elements: [] };

    // Resume from last successful checkpoint — do not re-run completed steps.
    // Evidence (pages / refs / faq rows) gates skips; step label alone is not enough.
    const pagesOk = await hasDonePages(ctx.documentId);
    if (!isStepDone(claimed.pipeline_step, 'pages_extracted') || !pagesOk) {
      currentStep = 'layout_extracted';
      extractPayload = await runExtractSteps(ctx);
    } else {
      console.log(`[pipeline] skip extract (checkpoint pages_extracted)`);
    }

    let interpretation: unknown = null;
    const hasRefs = (await getPolicyRefs(ctx.documentId)) != null;
    if (!isStepDone(claimed.pipeline_step, 'policy_refs') || !hasRefs) {
      currentStep = 'policy_refs';
      interpretation = await runPolicyRefs(ctx, extractPayload);
    } else {
      console.log(`[pipeline] skip policy_refs (checkpoint present)`);
      interpretation = await getPolicyRefs(ctx.documentId);
    }

    // Admin + customer: non-policy file → fail immediately, never ingest.
    if (isInvalidDocumentInterpretation(interpretation)) {
      currentStep = 'policy_refs';
      const message =
        'Invalid document: not an insurance policy-related file (invalid_document=true). Not ingested.';
      console.warn(
        `[pipeline] permanent fail doc=${ctx.documentId} source=${ctx.source}: ${message}`
      );
      await markPermanentlyFailed(ctx.documentId, 'policy_refs', message);
      await addEvent(ctx.documentId, 'policy_refs', `Failed: ${message}`, {
        invalid_document: true,
        permanent: true,
      });
      throw new PermanentPipelineError(message);
    }

    // Never leave a stale chat_ready=true while enrichment is still running.
    if (claimed.chat_ready && claimed.pipeline_status !== 'completed') {
      await setPipelineStep(ctx.documentId, claimed.pipeline_step ?? 'uploaded', {
        chatReady: false,
        pipelineStatus: 'running',
      });
    }

    if (!isStepDone(claimed.pipeline_step, 'vector_indexed')) {
      currentStep = 'vector_indexed';
      await runVectorIndex(ctx, {
        document: extractPayload.document,
        elements: extractPayload.elements,
        interpretation: interpretation ?? undefined,
      });
    } else {
      console.log(`[pipeline] skip vector_indexed (checkpoint present)`);
    }

    const needsSummaries = sourceNeedsSummaries(ctx.source);
    const needsFaqs = sourceNeedsFaqs(ctx.source);

    // FAQs: admin / folder only. Customer user flow is summaries-only.
    if (needsFaqs) {
      // Two checkpoints — faqs_generated (LLM raw) then faqs_stored (dedupe+DB).
      // Retries after dedupe timeout skip LLM when documents.result.faqRaw exists.
      if (
        !isStepDone(claimed.pipeline_step, 'faqs_stored') ||
        (await countFaqs(ctx.documentId)) === 0
      ) {
        const faqRawReady =
          isStepDone(claimed.pipeline_step, 'faqs_generated') &&
          Boolean(
            claimed.result &&
              typeof claimed.result === 'object' &&
              (claimed.result as { faqRaw?: unknown }).faqRaw
          );
        currentStep = faqRawReady ? 'faqs_stored' : 'faqs_generated';
        await runFaqSteps(ctx);
      } else {
        console.log(`[pipeline] skip faqs (checkpoint faqs_stored)`);
      }
    } else {
      console.log(
        `[pipeline] ${ctx.source} source — skipping FAQ generation doc=${ctx.documentId}`
      );
      await addEvent(
        ctx.documentId,
        'vector_indexed',
        'Customer upload: FAQ generation skipped (summaries only)'
      );
    }

    if (needsSummaries) {
      if (
        !isStepDone(claimed.pipeline_step, 'summary_generated') ||
        (await countSummaries(ctx.documentId)) === 0
      ) {
        currentStep = 'summary_generated';
        await runSummarySteps(ctx);
      } else {
        console.log(`[pipeline] skip summaries (checkpoint summary_generated)`);
      }
    } else {
      console.log(
        `[pipeline] ${ctx.source} source — skipping summary generation doc=${ctx.documentId}`
      );
      await addEvent(
        ctx.documentId,
        needsFaqs ? 'faqs_stored' : 'vector_indexed',
        `${ctx.source} upload: summary generation skipped`
      );
    }

    const faqCount = needsFaqs ? await countFaqs(ctx.documentId) : 0;
    const summaryCount = needsSummaries
      ? await countSummaries(ctx.documentId)
      : 0;
    if (needsFaqs && faqCount <= 0) {
      throw new Error(
        `Cannot mark chat_ready: document has 0 FAQs after FAQ step`
      );
    }
    if (needsSummaries && summaryCount <= 0) {
      throw new Error(
        `Cannot mark chat_ready: document has 0 section summaries after summary step`
      );
    }

    if (needsFaqs) {
      // FAQs stay inactive until the document succeeds — then publish for UI/chat.
      const activated = await activateFaqsForDocument(ctx.documentId);
      await addEvent(
        ctx.documentId,
        'faqs_stored',
        `Activated ${activated} FAQ(s) for document success`
      );
    }

    // Customer: full summary must land in chat before chat_ready (no FAQ categories).
    if (needsSummaries) {
      currentStep = 'completed';
      const live = await getDocument(ctx.documentId);
      if (!(live?.session_id || '').trim()) {
        throw new Error(
          'Cannot complete customer document: session_id missing (chat notify needs it)'
        );
      }

      const notify = await postFullSummaryToUserChat(ctx.documentId);
      if (!notify.posted && notify.reason !== 'already_posted') {
        throw new Error(
          `Full summary was not posted to chat (reason=${notify.reason || 'unknown'})`
        );
      }
      console.log(
        `[pipeline] full summary chat doc=${ctx.documentId} posted=${notify.posted} reason=${notify.reason || 'ok'}`
      );
    }

    currentStep = 'completed';
    await setPipelineStep(ctx.documentId, 'completed', {
      pipelineStatus: 'completed',
      chatReady: true,
      error: null,
    });
    await addEvent(
      ctx.documentId,
      'completed',
      needsSummaries
        ? `Pipeline completed (customer; summaries=${summaryCount}; faqs skipped; chat ready)`
        : `Pipeline completed (${ctx.source}; faqs=${faqCount}; summaries skipped; chat ready)`
    );

    await updateProgress({ step: 'completed', percent: 100 });

    const finalDoc = await getDocument(ctx.documentId);
    return {
      documentId: ctx.documentId,
      chatReady: Boolean(finalDoc?.chat_ready),
      status: finalDoc?.pipeline_status ?? 'completed',
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    // Permanent failures are already written; do not re-queue via markFailed.
    if (err instanceof PermanentPipelineError || err?.permanent === true) {
      const { UnrecoverableError } = await import('bullmq');
      throw new UnrecoverableError(message);
    }
    await markFailed(ctx.documentId, currentStep, message);
    await addEvent(ctx.documentId, currentStep, `Failed: ${message}`);
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}
