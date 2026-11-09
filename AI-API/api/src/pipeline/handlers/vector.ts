import axios from 'axios';
import { upsertDocumentProcessing } from '../files';
import {
  addEvent,
  getDocument,
  getPages,
  getPolicyRefs,
  setPipelineStep,
} from '../repository';
import { timeouts } from '../timeouts';
import type { StepContext } from '../types';

export async function runVectorIndex(
  ctx: StepContext,
  extras?: {
    document?: Record<string, unknown>;
    elements?: unknown[];
    interpretation?: unknown;
  }
): Promise<void> {
  const doc = await getDocument(ctx.documentId);
  if (!doc) {
    throw new Error(`Document ${ctx.documentId} not found for vector index`);
  }

  await ctx.updateProgress({
    step: 'vector_indexed',
    percent: 55,
    message: 'Indexing into vector store',
  });
  // Do not advance pipeline_step until ingest succeeds — retries must
  // resume this step, not skip it as already done.
  await addEvent(ctx.documentId, 'vector_indexed', 'Haystack ingest started');

  const pages = await getPages(ctx.documentId);
  const elements =
    extras?.elements?.length
      ? extras.elements
      : pages.flatMap((p) => {
          const els = p.elements_json;
          if (Array.isArray(els) && els.length) return els;
          return [
            {
              type: 'Text',
              text: p.text,
              page_number: p.page_number,
              element_id: `page-${p.page_number}`,
              metadata: { source: 'document_pages', page_number: p.page_number },
            },
          ];
        });

  const interpretation =
    extras?.interpretation ?? (await getPolicyRefs(ctx.documentId)) ?? {};

  // Customer uploads → customer collection; admin → general collection
  const collection = qdrantCollectionForSource(ctx.source);

  // Common contract: policy_id === policy_number (same string on Qdrant meta).
  const interpretationObj =
    interpretation && typeof interpretation === 'object' && !Array.isArray(interpretation)
      ? (interpretation as Record<string, unknown>)
      : {};
  const policyFromInterpret =
    typeof interpretationObj.policy_number === 'string'
      ? interpretationObj.policy_number.trim()
      : '';
  const policyId =
    (typeof doc?.policy_id === 'string' && doc.policy_id.trim()) ||
    policyFromInterpret ||
    null;

  const ingestPayload = {
    document: {
      ...(extras?.document ?? {}),
      document_id: String(ctx.documentId),
      filename: doc?.file_name ?? ctx.location,
      source: ctx.source,
      policy_id: policyId,
      policy_number: policyId,
      session_id: doc?.session_id ?? null,
      interpretation,
    },
    elements,
    collection,
    // Optional override only. If unset, haystack uses its EMBEDDING_* settings.
    ...(process.env.INGEST_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL
      ? {
          model:
            process.env.INGEST_EMBEDDING_MODEL ||
            process.env.EMBEDDING_MODEL,
        }
      : {}),
  };

  const HAYSTACK_INGEST =
    process.env.HAYSTACK_INGEST_URL || 'http://localhost:8000/ingest/';

  console.log(
    `[vector] ingest source=${ctx.source} collection=${collection} doc=${ctx.documentId}`
  );

  let ingestResp;
  try {
    ingestResp = await axios.post(HAYSTACK_INGEST, ingestPayload, {
      timeout: timeouts.ingest,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (err: unknown) {
    const ax = err as {
      code?: string;
      message?: string;
      response?: { status?: number; data?: { detail?: string } | unknown };
    };
    const detail =
      ax.response?.data &&
      typeof ax.response.data === 'object' &&
      ax.response.data !== null &&
      'detail' in ax.response.data
        ? String((ax.response.data as { detail: string }).detail)
        : ax.response?.data != null
          ? JSON.stringify(ax.response.data).slice(0, 400)
          : ax.message || String(err);
    // Common local failure: Qdrant not running on :6333
    throw new Error(
      `Haystack ingest failed (${ax.response?.status ?? ax.code ?? 'error'}): ${detail}`
    );
  }

  // Do NOT set chat_ready here — widget must wait for FAQs + summaries.
  await setPipelineStep(ctx.documentId, 'vector_indexed', {
    pipelineStatus: 'running',
    chatReady: false,
    result: {
      ingest: ingestResp.data ?? null,
      collection,
      source: ctx.source,
      vector_indexed_at: new Date().toISOString(),
    },
  });
  // Record processing fingerprint so later associations can reuse extract.
  // Vectors stay per document_id + collection (customer vs general).
  if (doc.file_id) {
    await upsertDocumentProcessing({
      fileId: doc.file_id,
      donorDocumentId: ctx.documentId,
    });
  }
  await addEvent(
    ctx.documentId,
    'vector_indexed',
    `Vector index complete (collection=${collection}); generating FAQs/summaries next`,
    { collection, source: ctx.source, fileId: doc.file_id ?? undefined }
  );
}

export function qdrantCollectionForSource(
  source: StepContext['source']
): string {
  if (source === 'customer') {
    return (
      process.env.QDRANT_COLLECTION_CUSTOMER?.trim() ||
      process.env.QDRANT_CUSTOMER_COLLECTION?.trim() ||
      'customer'
    );
  }
  return (
    process.env.QDRANT_COLLECTION_GENERAL?.trim() ||
    process.env.QDRANT_ADMIN_COLLECTION?.trim() ||
    process.env.QDRANT_COLLECTION?.trim() ||
    'general'
  );
}
