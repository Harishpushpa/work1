import { Request, Response } from 'express';
import pool from '../db';
import fs from 'fs';
import {
  addEvent,
  countDonePages,
  countFaqs,
  countSummaries,
  getDocument,
  listDocuments,
  listEvents,
  listFaqsForBrowse,
  requeueDocumentResume,
} from '../pipeline/repository';
import {
  DOCUMENT_SOURCES,
  isDocumentId,
  sourceNeedsFaqs,
  sourceNeedsSummaries,
  type DocumentSource,
} from '../pipeline/types';
import { enqueueDocumentJob } from '../queues/queue';
import { purgeDocumentFully } from '../pipeline/retention';

function fileSizeBytes(location: string | null | undefined): number {
  if (!location) return 0;
  try {
    return fs.statSync(location).size;
  } catch {
    return 0;
  }
}

function mimeFromName(fileName: string | null | undefined): string {
  const name = (fileName || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return 'application/octet-stream';
}

/** Map pipeline status → admin UI generationStatus. */
function toGenerationStatus(opts: {
  pipelineStatus: string;
  chatReady: boolean;
  enrichmentOk: boolean;
}): 'generating' | 'generated' | 'failed' {
  if (opts.pipelineStatus === 'failed') return 'failed';
  if (opts.pipelineStatus === 'completed' && opts.chatReady && opts.enrichmentOk) {
    return 'generated';
  }
  return 'generating';
}

/**
 * GET /documents?source=admin&limit=100
 * Admin portal document list (no chat; KB uploads).
 */
export async function listAdminDocuments(req: Request, res: Response) {
  try {
    const rawSource = String(req.query.source || 'admin').trim().toLowerCase();
    const source = (DOCUMENT_SOURCES as readonly string[]).includes(rawSource)
      ? (rawSource as DocumentSource)
      : 'admin';
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 500)
        : 100;

    const rows = await listDocuments({ source, limit });
    const documents = await Promise.all(
      rows.map(async (doc) => {
        const [faqCount, summaryCount] = await Promise.all([
          countFaqs(doc.id),
          countSummaries(doc.id),
        ]);
        const needsSummaries = sourceNeedsSummaries(doc.source);
        const needsFaqs = sourceNeedsFaqs(doc.source);
        const enrichmentOk =
          (!needsFaqs || faqCount > 0) &&
          (!needsSummaries || summaryCount > 0);
        const generationStatus = toGenerationStatus({
          pipelineStatus: doc.pipeline_status,
          chatReady: doc.chat_ready,
          enrichmentOk,
        });
        return {
          id: doc.id,
          documentId: doc.id,
          fileName: doc.file_name || 'document',
          fileType: mimeFromName(doc.file_name),
          fileSize: fileSizeBytes(doc.location),
          source: doc.source,
          pipelineStatus: doc.pipeline_status,
          pipelineStep: doc.pipeline_step,
          chatReady: doc.chat_ready,
          generationStatus,
          faqCount,
          summaryCount,
          currentVersion: 1,
          regenerateCount: 0,
          lastGeneratedAt:
            generationStatus === 'generated'
              ? doc.updated_at
              : null,
          lastRegeneratedAt: null,
          error: doc.error,
          createdAt: doc.created_at,
          updatedAt: doc.updated_at,
        };
      })
    );

    return res.json({ source, documents });
  } catch (err: any) {
    console.error('listAdminDocuments error:', err);
    return res.status(500).json({ error: err?.message || 'list_failed' });
  }
}

export async function getDocumentStatus(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!isDocumentId(id)) {
      return res.status(400).json({ error: 'Invalid document id (expected UUID)' });
    }

    const doc = await getDocument(id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const [events, pagesDone, faqCount, summaryCount] = await Promise.all([
      listEvents(id),
      countDonePages(id),
      countFaqs(id),
      countSummaries(id),
    ]);

    const pageTotal = doc.page_count ?? pagesDone;
    const needsSummaries = sourceNeedsSummaries(doc.source);
    const needsFaqs = sourceNeedsFaqs(doc.source);
    // Truly ready only when pipeline completed AND enrichment rows exist.
    // Customer: summaries only. Admin / folder: FAQs only.
    const enrichmentOk =
      (!needsFaqs || faqCount > 0) &&
      (!needsSummaries || summaryCount > 0);
    const trulyReady =
      doc.pipeline_status === 'completed' && doc.chat_ready && enrichmentOk;
    const staleReadyFlag =
      doc.chat_ready &&
      (doc.pipeline_status !== 'completed' || !enrichmentOk);

    // Progress: extract ~40%, vector ~20%, FAQs ~20%, summaries ~20% (customer).
    // Admin: FAQs take the remaining enrichment weight after vector.
    const percent = trulyReady
      ? 100
      : pageTotal > 0
        ? Math.min(
            95,
            Math.round((pagesDone / Math.max(pageTotal, 1)) * 40) +
              (doc.pipeline_step === 'vector_indexed' ||
              [
                'faqs_generated',
                'faqs_stored',
                'summary_generated',
                'completed',
              ].includes(String(doc.pipeline_step))
                ? 20
                : 0) +
              (faqCount > 0 ? (needsSummaries ? 20 : 35) : 0) +
              (needsSummaries && summaryCount > 0 ? 15 : 0)
          )
        : doc.pipeline_status === 'queued'
          ? 0
          : 5;

    const error =
      doc.error ||
      (staleReadyFlag
        ? `Pipeline incomplete: chat_ready was set early (step=${doc.pipeline_step}, faqs=${faqCount}, summaries=${summaryCount}, source=${doc.source})`
        : null);

    const generationStatus = toGenerationStatus({
      pipelineStatus: doc.pipeline_status,
      chatReady: doc.chat_ready,
      enrichmentOk,
    });

    const retriesExhausted =
      doc.pipeline_status === 'failed' &&
      Number(doc.retry_count) >= Number(doc.retry_limit);

    return res.json({
      id: doc.id,
      documentId: doc.id,
      fileName: doc.file_name,
      fileType: mimeFromName(doc.file_name),
      fileSize: fileSizeBytes(doc.location),
      source: doc.source,
      priority: doc.priority,
      location: doc.location,
      status: doc.status,
      pipelineStatus: doc.pipeline_status,
      pipelineStep: doc.pipeline_step,
      chatReady: trulyReady,
      generationStatus,
      pageCount: doc.page_count,
      pagesDone,
      faqCount,
      summaryCount,
      percent,
      error,
      retryCount: doc.retry_count,
      retryLimit: doc.retry_limit,
      /** True only when automatic queue retries are finished — UI may show Retry. */
      retriesExhausted,
      lastHeartbeatAt: doc.last_heartbeat_at,
      lastGeneratedAt:
        generationStatus === 'generated' ? doc.updated_at : null,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      events: events.map((e) => ({
        step: e.step,
        message: e.message,
        meta: e.meta,
        at: e.created_at,
      })),
    });
  } catch (err: any) {
    console.error('getDocumentStatus error:', err);
    return res.status(500).json({ error: err?.message || 'status_failed' });
  }
}

/**
 * POST /documents/:id/requeue
 * Resume pipeline from the last successful checkpoint (does not clear pages/FAQs).
 * Use force re-upload to start from the beginning instead.
 */
export async function requeueDocument(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!isDocumentId(id)) {
      return res.status(400).json({ error: 'Invalid document id (expected UUID)' });
    }

    const existing = await getDocument(id);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (existing.pipeline_status === 'completed') {
      return res.status(409).json({
        error: 'Document already completed. Re-upload with force to start over.',
        pipelineStatus: existing.pipeline_status,
        pipelineStep: existing.pipeline_step,
      });
    }

    if (existing.pipeline_status === 'running') {
      return res.status(409).json({
        error: 'Document is already running. Wait for it to finish or fail.',
        pipelineStatus: existing.pipeline_status,
        pipelineStep: existing.pipeline_step,
      });
    }

    const doc = await requeueDocumentResume(id);
    if (!doc) {
      return res.status(409).json({
        error: `Cannot requeue from status=${existing.pipeline_status}`,
        pipelineStatus: existing.pipeline_status,
        pipelineStep: existing.pipeline_step,
      });
    }

    const enqueued = await enqueueDocumentJob(
      { documentId: doc.id, source: doc.source },
      { force: true }
    );

    await addEvent(doc.id, doc.pipeline_step || 'uploaded', 'Manual requeue — resume from checkpoint', {
      resumeFrom: doc.pipeline_step,
      jobId: enqueued.jobId,
      mode: 'resume',
    });

    return res.status(202).json({
      id: doc.id,
      documentId: doc.id,
      pipelineStatus: 'queued',
      pipelineStep: doc.pipeline_step,
      mode: 'resume',
      jobId: enqueued.jobId,
      queue: enqueued.queue,
      message:
        'Requeued. Pipeline will resume from the last successful step (not a full restart).',
    });
  } catch (err: any) {
    console.error('requeueDocument error:', err);
    return res.status(500).json({ error: err?.message || 'requeue_failed' });
  }
}

export async function listDocumentFaqs(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!isDocumentId(id)) {
      return res.status(400).json({ error: 'Invalid document id (expected UUID)' });
    }

    const categoryId =
      typeof req.query.categoryId === 'string' && req.query.categoryId.trim()
        ? req.query.categoryId.trim()
        : null;
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 50)
        : null;

    // Includes document-specific FAQs and policy-id-scoped FAQs (same policy_id / kb_id).
    const browsed = await listFaqsForBrowse({
      documentId: id,
      categoryId,
      limit,
    });

    const { rows: cats } = await pool.query(`SELECT id, name FROM faq_categories`);
    const faqs = browsed.faqs.map((f: any) => {
      const name = cats.find((c: any) => c.id === (f.category_id ?? f.categoryId))?.name ?? 'others';
      return { ...f, category_name: name };
    });

    return res.json({
      documentId: browsed.documentId,
      policyId: browsed.policyId,
      categoryId,
      limit,
      faqs,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'faqs_failed' });
  }
}

/**
 * DELETE /documents/:id
 * Full delete: uploaded file + Qdrant vectors + FAQs/summaries + pipeline rows + document.
 */
export async function deleteDocument(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!isDocumentId(id)) {
      return res.status(400).json({ error: 'Invalid document id (expected UUID)' });
    }

    const existing = await getDocument(id);
    if (!existing) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (existing.pipeline_status === 'running') {
      return res.status(409).json({
        error: 'Document is still processing. Wait for it to finish or fail, then delete.',
        pipelineStatus: existing.pipeline_status,
      });
    }

    const result = await purgeDocumentFully(existing);
    return res.json({
      id: existing.id,
      deleted: true,
      fileRemoved: result.fileRemoved,
      faqsDeleted: result.faqsDeleted,
      detail: result.detail,
    });
  } catch (err: any) {
    console.error('deleteDocument error:', err);
    return res.status(500).json({ error: err?.message || 'delete_failed' });
  }
}

/**
 * POST /documents/bulk-delete
 * Body: { ids: string[] } — deletes each document fully (file, vectors, FAQs, pipeline).
 */
export async function bulkDeleteDocuments(req: Request, res: Response) {
  try {
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = [
      ...new Set(
        rawIds
          .map((value: unknown) => String(value || '').trim())
          .filter((value: string) => isDocumentId(value))
      ),
    ] as string[];

    if (ids.length === 0) {
      return res.status(400).json({ error: 'Provide at least one valid document id in ids[]' });
    }
    if (ids.length > 50) {
      return res.status(400).json({ error: 'Bulk delete is limited to 50 documents at a time' });
    }

    const deleted: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const existing = await getDocument(id);
        if (!existing) {
          failed.push({ id, error: 'Document not found' });
          continue;
        }
        if (existing.pipeline_status === 'running') {
          failed.push({
            id,
            error: 'Document is still processing',
          });
          continue;
        }
        await purgeDocumentFully(existing);
        deleted.push(id);
      } catch (err: any) {
        failed.push({
          id,
          error: err?.message || 'delete_failed',
        });
      }
    }

    return res.json({
      deleted,
      failed,
      deletedCount: deleted.length,
      failedCount: failed.length,
    });
  } catch (err: any) {
    console.error('bulkDeleteDocuments error:', err);
    return res.status(500).json({ error: err?.message || 'bulk_delete_failed' });
  }
}

export async function listDocumentSummaries(req: Request, res: Response) {
  try {
    const id = String(req.params.id);
    if (!isDocumentId(id)) {
      return res.status(400).json({ error: 'Invalid document id (expected UUID)' });
    }
    // Shared product table (same DB as app-api)
    const resDb = await pool.query(
      `SELECT id, document_id, version, type, section_id, section_name,
              page_start, page_end, summary, prompt_version, needs_review, created_at
       FROM summaries
       WHERE document_id = $1
       ORDER BY version DESC,
                CASE WHEN type = 'full' THEN 0 ELSE 1 END,
                page_start NULLS LAST,
                created_at ASC`,
      [id]
    );
    return res.json({ documentId: id, summaries: resDb.rows });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'summaries_failed' });
  }
}
