import axios from 'axios';
import {
  addEvent,
  getDocument,
  getPolicyRefs,
  listSummaries,
  type StoredSummaryRow,
} from '../repository';
import { timeouts } from '../timeouts';
import type { StepContext } from '../types';
import { qdrantCollectionForSource } from './vector';

function normalizeSummaryIngestUrl(): string {
  const explicit = process.env.HAYSTACK_SUMMARY_INGEST_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = (
    process.env.HAYSTACK_INGEST_URL || 'http://localhost:8000/ingest/'
  ).replace(/\/+$/, '');
  if (/\/summaries$/i.test(base)) return base;
  if (/\/ingest$/i.test(base)) return `${base}/summaries`;
  return `${base}/ingest/summaries`;
}

/**
 * Embed section + full summaries into the same Qdrant collection as document chunks.
 * Tags: content_type=summary, summary_type=section|full.
 */
export async function ingestSummariesToQdrant(
  ctx: StepContext,
  summaries?: StoredSummaryRow[]
): Promise<{ ingested: number; collection: string }> {
  const rows =
    summaries && summaries.length
      ? summaries
      : await listSummaries(ctx.documentId);
  const usable = rows.filter((r) => String(r.summary || '').trim());
  if (!usable.length) {
    return { ingested: 0, collection: qdrantCollectionForSource(ctx.source) };
  }

  const doc = await getDocument(ctx.documentId);
  if (!doc) {
    throw new Error(`Document ${ctx.documentId} not found for summary ingest`);
  }

  const collection = qdrantCollectionForSource(ctx.source);
  const interpretation = (await getPolicyRefs(ctx.documentId)) ?? {};
  const interpretationObj =
    interpretation && typeof interpretation === 'object' && !Array.isArray(interpretation)
      ? (interpretation as Record<string, unknown>)
      : {};
  const policyFromInterpret =
    typeof interpretationObj.policy_number === 'string'
      ? interpretationObj.policy_number.trim()
      : '';
  const policyId =
    (typeof doc.policy_id === 'string' && doc.policy_id.trim()) ||
    policyFromInterpret ||
    null;

  const url = normalizeSummaryIngestUrl();
  const payload = {
    document: {
      document_id: String(ctx.documentId),
      filename: doc.file_name ?? ctx.location,
      source: ctx.source,
      policy_id: policyId,
      policy_number: policyId,
      session_id: doc.session_id ?? null,
      interpretation,
    },
    collection,
    // Optional override only. If unset, haystack uses its EMBEDDING_* settings.
    ...(process.env.INGEST_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL
      ? {
          model:
            process.env.INGEST_EMBEDDING_MODEL ||
            process.env.EMBEDDING_MODEL,
        }
      : {}),
    summaries: usable.map((s) => ({
      summary: s.summary,
      type: s.type,
      section_id: s.sectionId,
      section_name: s.sectionName,
      page_start: s.pageStart,
      page_end: s.pageEnd,
    })),
  };

  console.log(
    `[summaries:vector] POST ${url} collection=${collection} count=${usable.length} doc=${ctx.documentId}`
  );

  try {
    const resp = await axios.post(url, payload, {
      timeout: timeouts.ingest,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const ingested = Number(resp.data?.ingested ?? usable.length) || 0;
    await addEvent(
      ctx.documentId,
      'summary_generated',
      `Indexed ${ingested} summary vectors into Qdrant (${collection})`,
      { collection, ingested }
    );
    return { ingested, collection };
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
    throw new Error(
      `Summary Qdrant ingest failed (${ax.response?.status ?? ax.code ?? 'error'}): ${detail}`
    );
  }
}
