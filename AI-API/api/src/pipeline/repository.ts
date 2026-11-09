import pool from '../db';
import { pipelineConfig } from './config';
import {
  PIPELINE_STEPS,
  isDocumentUuid,
  type DocumentId,
  type DocumentSource,
  type PipelineStatus,
  type PipelineStep,
} from './types';

export type DocumentRow = {
  id: DocumentId;
  /** Product external id (same as id::text for app-ai uploads) */
  document_id: string;
  location: string;
  status: string;
  pipeline_step: PipelineStep | null;
  pipeline_status: PipelineStatus;
  source: DocumentSource;
  priority: number;
  file_name: string | null;
  file_hash: string | null;
  /** Shared physical file id (content-addressed). */
  file_id: string | null;
  file_type?: string | null;
  file_size?: number | null;
  page_count: number | null;
  chat_ready: boolean;
  generation_status?: string | null;
  policy_id: string | null;
  session_id: string | null;
  retry_count: number;
  retry_limit: number;
  error: string | null;
  result: unknown;
  last_heartbeat_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export async function getDocument(
  id: DocumentId
): Promise<DocumentRow | null> {
  const res = await pool.query(`SELECT * FROM documents WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}

/** List documents for admin portal (newest first). Optional source filter. */
export async function listDocuments(opts?: {
  source?: DocumentSource | null;
  limit?: number;
}): Promise<DocumentRow[]> {
  const limit =
    opts?.limit && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 500) : 100;
  const source = opts?.source ? String(opts.source).trim().toLowerCase() : null;
  if (source) {
    const res = await pool.query(
      `SELECT * FROM documents
       WHERE source = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [source, limit]
    );
    return res.rows;
  }
  const res = await pool.query(
    `SELECT * FROM documents
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/**
 * Latest document with same content + source.
 * Prefers file_id join when present; falls back to denormalized file_hash.
 */
export async function findByFileHash(
  fileHash: string,
  source: DocumentSource,
  policyId?: string | null
): Promise<DocumentRow | null> {
  const policy = (policyId || '').trim();
  const hash = fileHash.trim().toLowerCase();
  // Prefer shared files.file_id association.
  const byFileId = policy
    ? await pool.query(
        `SELECT d.* FROM documents d
         LEFT JOIN files f ON f.id = d.file_id
         WHERE d.source = $2
           AND (f.file_hash = $1 OR d.file_hash = $1)
           AND d.policy_id = $3
         ORDER BY d.created_at DESC
         LIMIT 1`,
        [hash, source, policy]
      )
    : await pool.query(
        `SELECT d.* FROM documents d
         LEFT JOIN files f ON f.id = d.file_id
         WHERE d.source = $2
           AND (f.file_hash = $1 OR d.file_hash = $1)
         ORDER BY d.created_at DESC
         LIMIT 1`,
        [hash, source]
      );
  return byFileId.rows[0] ?? null;
}

/** Point a document at the current chat session (customer reuse / rebind). */
export async function updateDocumentSessionId(
  documentId: DocumentId,
  sessionId: string | null
): Promise<void> {
  const value = (sessionId || '').trim() || null;
  await pool.query(
    `UPDATE documents
     SET session_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [documentId, value]
  );
}

export async function claimDocument(
  id: DocumentId
): Promise<DocumentRow | null> {
  const res = await pool.query(
    `UPDATE documents
     SET pipeline_status = 'running',
         status = 'processing',
         generation_status = 'generating'::document_status,
         last_heartbeat_at = NOW(),
         error = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND pipeline_status IN ('queued', 'failed', 'running', 'chat_ready')
       AND (pipeline_status <> 'failed' OR retry_count < retry_limit)
     RETURNING *`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function touchHeartbeat(id: DocumentId): Promise<void> {
  await pool.query(
    `UPDATE documents
     SET last_heartbeat_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND pipeline_status = 'running'`,
    [id]
  );
}

/** Running docs whose heartbeat is older than stuck threshold. */
export async function findStuckDocuments(
  stuckOlderThanMs: number = pipelineConfig.stuckThresholdMs
): Promise<DocumentRow[]> {
  const res = await pool.query(
    `SELECT * FROM documents
     WHERE pipeline_status = 'running'
       AND (
         last_heartbeat_at IS NULL
         OR last_heartbeat_at < NOW() - ($1::text || ' milliseconds')::interval
       )
     ORDER BY updated_at ASC
     LIMIT 50`,
    [String(stuckOlderThanMs)]
  );
  return res.rows;
}

/**
 * Re-queue a stuck/failed doc for another attempt (respects retry_limit).
 * Returns true if re-queued.
 */
export async function requeueStuckDocument(
  id: DocumentId,
  reason: string
): Promise<DocumentRow | null> {
  const res = await pool.query(
    `UPDATE documents
     SET retry_count = retry_count + 1,
         pipeline_status = CASE
           WHEN retry_count + 1 >= retry_limit THEN 'failed'
           ELSE 'queued'
         END,
         status = CASE
           WHEN retry_count + 1 >= retry_limit THEN 'failed'
           ELSE 'pending'
         END,
         error = $2,
         last_heartbeat_at = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND pipeline_status = 'running'
     RETURNING *`,
    [id, reason]
  );
  return res.rows[0] ?? null;
}

/**
 * Manual requeue: resume from last successful checkpoint.
 * Keeps pages / policy_refs / FAQs / summaries and `pipeline_step`.
 * Clears error and resets retry budget so claimDocument can pick it up.
 */
export async function requeueDocumentResume(
  id: DocumentId
): Promise<DocumentRow | null> {
  const res = await pool.query(
    `UPDATE documents
     SET pipeline_status = 'queued',
         status = 'pending',
         generation_status = 'generating'::document_status,
         chat_ready = false,
         error = NULL,
         last_heartbeat_at = NULL,
         retry_count = 0,
         updated_at = NOW()
     WHERE id = $1
       AND pipeline_status IN ('failed', 'queued')
     RETURNING *`,
    [id]
  );
  return res.rows[0] ?? null;
}

/** Reset an existing doc so force=true can re-run the pipeline. */
export async function resetDocumentForReprocess(
  id: DocumentId,
  input: {
    location: string;
    fileName?: string;
    fileHash?: string;
    fileId?: string | null;
    fileType?: string | null;
    fileSize?: number | null;
    priority: number;
    policyId?: string | null;
    sessionId?: string | null;
  }
): Promise<DocumentRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Clear checkpoints so extract/FAQ/summary run again
    await client.query(`DELETE FROM document_pages WHERE document_id = $1`, [id]);
    await client.query(`DELETE FROM document_policy_refs WHERE document_id = $1`, [
      id,
    ]);
    // Shared product tables: clear FAQs/summaries for this document on force reprocess.
    await client.query(`DELETE FROM faqs WHERE document_id = $1`, [String(id)]);
    await client.query('SAVEPOINT clear_summaries');
    try {
      await client.query(`DELETE FROM summaries WHERE document_id = $1`, [
        String(id),
      ]);
      await client.query('RELEASE SAVEPOINT clear_summaries');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT clear_summaries');
    }
    // Legacy pipeline tables (optional on shared DB)
    for (const table of ['document_faqs', 'document_summaries'] as const) {
      await client.query('SAVEPOINT legacy_clear');
      try {
        await client.query(`DELETE FROM ${table} WHERE document_id = $1`, [id]);
        await client.query('RELEASE SAVEPOINT legacy_clear');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT legacy_clear');
      }
    }

    const res = await client.query(
      `UPDATE documents
       SET location = $2,
           file_name = COALESCE($3, file_name),
           file_hash = COALESCE($4, file_hash),
           file_id = COALESCE($5, file_id),
           file_type = COALESCE($6, file_type),
           file_size = COALESCE($7, file_size),
           priority = $8,
           policy_id = COALESCE($9, policy_id),
           session_id = COALESCE($10, session_id),
           document_id = COALESCE(NULLIF(trim(document_id), ''), id::text),
           generation_status = 'generating',
           status = 'pending',
           pipeline_step = 'uploaded',
           pipeline_status = 'queued',
           chat_ready = false,
           error = NULL,
           result = NULL,
           last_heartbeat_at = NULL,
           retry_count = 0,
           retry_limit = $11,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        input.location,
        input.fileName ?? null,
        input.fileHash ?? null,
        input.fileId ?? null,
        input.fileType ?? null,
        input.fileSize ?? null,
        input.priority,
        input.policyId?.trim() || null,
        input.sessionId?.trim() || null,
        pipelineConfig.retryLimit,
      ]
    );
    await client.query('COMMIT');
    return res.rows[0] ?? null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function setPipelineStep(
  id: DocumentId,
  step: PipelineStep,
  extras: {
    pipelineStatus?: PipelineStatus;
    pageCount?: number;
    chatReady?: boolean;
    error?: string | null;
    result?: unknown;
  } = {}
) {
  // Only overwrite error when caller passes `error` — never clear silently.
  const touchError = Object.prototype.hasOwnProperty.call(extras, 'error');
  await pool.query(
    `UPDATE documents
     SET pipeline_step = $2,
         pipeline_status = COALESCE($3, pipeline_status),
         page_count = COALESCE($4, page_count),
         chat_ready = COALESCE($5, chat_ready),
         error = CASE WHEN $6::boolean THEN $7 ELSE error END,
         result = COALESCE($8, result),
         status = CASE
           WHEN $3 = 'completed' THEN 'processed'
           WHEN $3 = 'failed' THEN 'failed'
           WHEN $3 = 'chat_ready' THEN 'processing'
           ELSE status
         END,
         generation_status = CASE
           WHEN $3 = 'completed' THEN 'generated'::document_status
           WHEN $3 = 'failed' THEN 'failed'::document_status
           ELSE generation_status
         END,
         last_generated_at = CASE
           WHEN $3 = 'completed' THEN NOW()
           ELSE last_generated_at
         END,
         updated_at = NOW()
     WHERE id = $1`,
    [
      id,
      step,
      extras.pipelineStatus ?? null,
      extras.pageCount ?? null,
      extras.chatReady ?? null,
      touchError,
      touchError ? extras.error ?? null : null,
      extras.result === undefined ? null : JSON.stringify(extras.result),
    ]
  );
}

/**
 * Mark a pipeline attempt as failed and re-queue for retry (if under limit).
 * Keeps `pipeline_step` at the last *successful* checkpoint so the next
 * attempt resumes there instead of re-running completed steps.
 * The failed step name is recorded in `error` / events only.
 */
export async function markFailed(
  id: DocumentId,
  step: PipelineStep,
  error: string
) {
  await pool.query(
    `UPDATE documents
     SET retry_count = retry_count + 1,
         pipeline_status = CASE
           WHEN retry_count + 1 >= retry_limit THEN 'failed'
           ELSE 'queued'
         END,
         status = CASE
           WHEN retry_count + 1 >= retry_limit THEN 'failed'
           ELSE 'pending'
         END,
         generation_status = CASE
           WHEN retry_count + 1 >= retry_limit THEN 'failed'::document_status
           ELSE generation_status
         END,
         chat_ready = false,
         error = $2,
         last_heartbeat_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id, `[${step}] ${error}`]
  );
}

/**
 * Immediate terminal failure — no re-queue / retries.
 * Used for non-recoverable content (e.g. invalid_document from interpret).
 */
export async function markPermanentlyFailed(
  id: DocumentId,
  step: PipelineStep,
  error: string
) {
  await pool.query(
    `UPDATE documents
     SET pipeline_step = $2,
         pipeline_status = 'failed',
         status = 'failed',
         generation_status = 'failed'::document_status,
         chat_ready = false,
         retry_count = retry_limit,
         error = $3,
         last_heartbeat_at = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [id, step, `[${step}] ${error}`]
  );
}

export async function addEvent(
  documentId: DocumentId,
  step: PipelineStep | string,
  message: string,
  meta: Record<string, unknown> = {}
) {
  await pool.query(
    `INSERT INTO document_pipeline_events (document_id, step, message, meta)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [documentId, step, message, JSON.stringify(meta)]
  );
}

export async function listEvents(documentId: DocumentId) {
  const res = await pool.query(
    `SELECT id, step, message, meta, created_at
     FROM document_pipeline_events
     WHERE document_id = $1
     ORDER BY id ASC`,
    [documentId]
  );
  return res.rows;
}

export async function countDonePages(documentId: DocumentId): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM document_pages
     WHERE document_id = $1 AND status = 'done'`,
    [documentId]
  );
  return res.rows[0]?.n ?? 0;
}

export async function hasDonePages(documentId: DocumentId): Promise<boolean> {
  return (await countDonePages(documentId)) > 0;
}

export async function upsertPage(input: {
  documentId: DocumentId;
  pageNumber: number;
  text: string;
  layoutJson?: unknown;
  elementsJson?: unknown;
  ocrConfidence?: number | null;
  status?: string;
}) {
  await pool.query(
    `INSERT INTO document_pages (
       document_id, page_number, text, layout_json, elements_json, ocr_confidence, status, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, NOW())
     ON CONFLICT (document_id, page_number)
     DO UPDATE SET
       text = EXCLUDED.text,
       layout_json = EXCLUDED.layout_json,
       elements_json = EXCLUDED.elements_json,
       ocr_confidence = EXCLUDED.ocr_confidence,
       status = EXCLUDED.status,
       updated_at = NOW()`,
    [
      input.documentId,
      input.pageNumber,
      input.text,
      JSON.stringify(input.layoutJson ?? null),
      JSON.stringify(input.elementsJson ?? null),
      input.ocrConfidence ?? null,
      input.status ?? 'done',
    ]
  );
}

export async function getPages(documentId: DocumentId) {
  const res = await pool.query(
    `SELECT page_number, text, elements_json, status, ocr_confidence
     FROM document_pages
     WHERE document_id = $1
     ORDER BY page_number ASC`,
    [documentId]
  );
  return res.rows;
}

export async function savePolicyRefs(documentId: DocumentId, refs: unknown) {
  await pool.query(
    `INSERT INTO document_policy_refs (document_id, refs, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (document_id)
     DO UPDATE SET refs = EXCLUDED.refs, updated_at = NOW()`,
    [documentId, JSON.stringify(refs)]
  );
}

export async function getPolicyRefs(documentId: DocumentId) {
  const res = await pool.query(
    `SELECT refs FROM document_policy_refs WHERE document_id = $1`,
    [documentId]
  );
  return res.rows[0]?.refs ?? null;
}

function normalizeQuestion(q: string): string {
  return String(q || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function toPageArray(pageRefs: unknown): number[] {
  if (!Array.isArray(pageRefs)) return [];
  return pageRefs.filter(
    (p): p is number => typeof p === 'number' && Number.isInteger(p)
  );
}

type PgClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

async function loadCategoryIdsByName(
  client: PgClient
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await client.query(
      `SELECT id::text AS id, name FROM faq_categories`
    );
    for (const row of res.rows) {
      const name = String(row.name || '')
        .trim()
        .toLowerCase();
      if (name) map.set(name, row.id);
    }
  } catch {
    // faq_categories may be empty / missing until app-api migrations run
  }
  return map;
}

/** Admin-owned category names for FAQ LLM prompts (display casing preserved). */
export async function listFaqCategoryNames(): Promise<string[]> {
  try {
    const res = await pool.query(
      `SELECT name FROM faq_categories ORDER BY name ASC`
    );
    const seen = new Set<string>();
    const names: string[] = [];
    for (const row of res.rows) {
      const name = String(row.name || '').trim().slice(0, 150);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Resolve category_id by name; insert into faq_categories when missing so
 * FAQs never land with a null category_id when a name is present.
 */
async function ensureFaqCategoryId(
  client: PgClient,
  cache: Map<string, string>,
  rawName: string
): Promise<{ id: string; name: string } | null> {
  const name = String(rawName || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 150);
  if (!name) return null;

  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached) return { id: cached, name };

  try {
    const existing = await client.query(
      `SELECT id::text AS id, name FROM faq_categories
       WHERE lower(trim(name)) = lower(trim($1))
       LIMIT 1`,
      [name]
    );
    if (existing.rows[0]?.id) {
      const id = String(existing.rows[0].id);
      const canonical = String(existing.rows[0].name || name).trim() || name;
      cache.set(key, id);
      cache.set(canonical.toLowerCase(), id);
      return { id, name: canonical };
    }

    // faq_categories has no UNIQUE(name) in app-api — select-then-insert only.
    const inserted = await client.query(
      `INSERT INTO faq_categories (id, name)
       VALUES (gen_random_uuid(), $1)
       RETURNING id::text AS id, name`,
      [name]
    );
    const row = inserted.rows[0];
    if (!row?.id) return null;
    const id = String(row.id);
    const canonical = String(row.name || name).trim() || name;
    cache.set(key, id);
    cache.set(canonical.toLowerCase(), id);
    return { id, name: canonical };
  } catch (err) {
    console.warn(
      `[faqs] ensureFaqCategoryId failed for "${name}":`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function nextFaqVersion(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  documentId: string
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM faqs WHERE document_id = $1`,
    [documentId]
  );
  return Number(res.rows[0]?.v ?? 1);
}

async function nextFaqPosition(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  type: 'general' | 'specific'
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM faqs WHERE type = $1`,
    [type]
  );
  return Number(res.rows[0]?.p ?? 0);
}

/**
 * Insert FAQs into the shared product `faqs` table (same DB / schema as app-api).
 * Rows are stored as status=pending and active=false until the document pipeline
 * completes (see activateFaqsForDocument). UI / chat only show active FAQs.
 * General FAQs that already exist (non-rejected) are skipped as duplicates.
 */
export async function replaceFaqs(
  documentId: DocumentId,
  faqs: Array<{
    scope: string;
    category?: string | null;
    question: string;
    answer: string;
    sectionId?: string | null;
    sectionName?: string | null;
    pageRefs?: unknown;
    promptVersion?: string | null;
    needsReview?: boolean;
  }>,
  opts?: { documentName?: string | null; policyId?: string | null }
): Promise<{ inserted: number; skippedGeneral: number; version: number }> {
  const docId = String(documentId);
  const documentName = (opts?.documentName || '').slice(0, 255) || null;
  const policyId = (opts?.policyId || '').trim() || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const categoryIds = await loadCategoryIdsByName(client);
    const version = await nextFaqVersion(client, docId);
    let nextGeneral = await nextFaqPosition(client, 'general');
    let nextSpecific = await nextFaqPosition(client, 'specific');

    const knownGeneral = new Set<string>();
    {
      // Dedupe general FAQs within the same policy (or globally when no policy).
      // Include inactive drafts so a failed run does not create duplicates on retry.
      // Policy lives in metadata.policy_id (app-api faqs has no kb_id column).
      const existing = policyId
        ? await client.query(
            `SELECT question FROM faqs
             WHERE type = 'general' AND status <> 'rejected'
               AND metadata->>'policy_id' = $1`,
            [policyId]
          )
        : await client.query(
            `SELECT question FROM faqs
             WHERE type = 'general' AND status <> 'rejected'`
          );
      for (const row of existing.rows) {
        knownGeneral.add(normalizeQuestion(row.question));
      }
    }

    let inserted = 0;
    let skippedGeneral = 0;

    for (const f of faqs) {
      const question = String(f.question || '').trim();
      const answer = String(f.answer || '').trim();
      if (!question || !answer) continue;

      const isGeneral = f.scope === 'global' || f.scope === 'general';
      // Live product schema still has NOT NULL scope (global|specific), parallel to type.
      // Newer app-api docs drop scope — keep writing both until Option B migration.
      const type = isGeneral ? 'general' : 'specific';
      const scope = isGeneral ? 'global' : 'specific';
      const kbId = policyId ?? '';

      if (isGeneral) {
        const key = normalizeQuestion(question);
        if (knownGeneral.has(key)) {
          skippedGeneral += 1;
          continue;
        }
        knownGeneral.add(key);
      }

      const rawCategory = f.category ? String(f.category).trim() : '';
      const resolved = await ensureFaqCategoryId(
        client,
        categoryIds,
        rawCategory || 'Other'
      );
      const categoryId = resolved?.id ?? null;
      const categoryName = resolved?.name ?? (rawCategory || 'Other');
      const pages = isGeneral ? [] : toPageArray(f.pageRefs);
      const sectionId = isGeneral ? null : f.sectionId ?? null;
      const section = isGeneral ? null : f.sectionName ?? null;
      const position = isGeneral ? nextGeneral++ : nextSpecific++;
      const metadata = {
        needs_review: f.needsReview === true,
        category_name: categoryName || null,
        ...(policyId ? { policy_id: policyId } : {}),
      };

      await client.query(
        `INSERT INTO faqs (
           document_id, document_name, version, type, scope, kb_id, category_id,
           question, answer, section_id, section, pages,
           status, position, prompt_version, metadata, active
         ) VALUES (
           $1, $2, $3, $4::faq_type, $5, $6, $7::uuid,
           $8, $9, $10, $11, $12::integer[],
           'pending'::faq_status, $13, $14, $15::jsonb, false
         )`,
        [
          docId,
          documentName,
          version,
          type,
          scope,
          kbId,
          categoryId,
          question,
          answer,
          sectionId,
          section,
          pages,
          position,
          f.promptVersion ?? null,
          JSON.stringify(metadata),
        ]
      );
      inserted += 1;
    }

    await client.query('COMMIT');
    return { inserted, skippedGeneral, version };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Count FAQs stored for a document (pipeline checkpoint).
 * Includes inactive drafts — visibility is gated by `active` for UI/chat.
 */
export async function countFaqs(documentId: DocumentId): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM faqs
     WHERE document_id = $1
       AND COALESCE(status::text, 'pending') <> 'rejected'`,
    [String(documentId)]
  );
  return res.rows[0]?.n ?? 0;
}

/** Publish draft FAQs after the document pipeline succeeds. */
export async function activateFaqsForDocument(
  documentId: DocumentId
): Promise<number> {
  const res = await pool.query(
    `UPDATE faqs
     SET active = true
     WHERE document_id = $1
       AND COALESCE(active, false) = false
       AND COALESCE(status::text, 'pending') <> 'rejected'`,
    [String(documentId)]
  );
  return res.rowCount ?? 0;
}

/**
 * Insert section summaries into shared `summaries` (app-api table).
 * Appends rows for the latest FAQ version; does not delete prior versions.
 */
export async function replaceSummaries(
  documentId: DocumentId,
  summaries: Array<{
    type?: 'section' | 'full';
    scope?: string;
    sectionId?: string | null;
    sectionName?: string | null;
    pageStart?: number | null;
    pageEnd?: number | null;
    summary: string;
    promptVersion?: string | null;
    needsReview?: boolean;
  }>,
  opts?: { documentName?: string | null; version?: number }
): Promise<{ inserted: number; version: number }> {
  const docId = String(documentId);
  const documentName = (opts?.documentName || '').slice(0, 255) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const version =
      opts?.version ??
      (
        await client.query(
          `SELECT COALESCE(MAX(version), 1) AS v FROM faqs WHERE document_id = $1`,
          [docId]
        )
      ).rows[0]?.v ??
      1;

    // Replace this version's rows so re-runs / dual writers don't violate
    // the one-full-per-(document,version) unique index.
    await client.query(
      `DELETE FROM summaries WHERE document_id = $1 AND version = $2`,
      [docId, version]
    );

    let inserted = 0;
    for (const s of summaries) {
      const summary = String(s.summary || '').trim();
      if (!summary) continue;
      const rawType = String(s.type || s.scope || 'section').toLowerCase();
      const type: 'section' | 'full' =
        rawType === 'full' || rawType === 'document' ? 'full' : 'section';
      const sectionId = type === 'full' ? null : (s.sectionId ?? null);
      const sectionName = type === 'full' ? null : (s.sectionName ?? null);
      await client.query(
        `INSERT INTO summaries (
           document_id, document_name, version, type,
           section_id, section_name, page_start, page_end,
           summary, needs_review, prompt_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          docId,
          documentName,
          version,
          type,
          sectionId,
          sectionName,
          s.pageStart ?? null,
          s.pageEnd ?? null,
          summary,
          s.needsReview ?? false,
          s.promptVersion ?? null,
        ]
      );
      inserted += 1;
    }
    await client.query('COMMIT');
    return { inserted, version: Number(version) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function countSummaries(documentId: DocumentId): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM summaries WHERE document_id = $1`,
    [String(documentId)]
  );
  return res.rows[0]?.n ?? 0;
}

export type StoredSummaryRow = {
  type: 'section' | 'full';
  sectionId: string | null;
  sectionName: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  summary: string;
  promptVersion: string | null;
  needsReview: boolean;
  version: number;
};

/** Latest-version summaries for a document (section + full). */
export async function listSummaries(
  documentId: DocumentId
): Promise<StoredSummaryRow[]> {
  const res = await pool.query(
    `SELECT type, section_id, section_name, page_start, page_end,
            summary, prompt_version, needs_review, version
     FROM summaries
     WHERE document_id = $1
       AND version = (
         SELECT COALESCE(MAX(version), 1) FROM summaries WHERE document_id = $1
       )
     ORDER BY CASE WHEN type = 'full' THEN 0 ELSE 1 END,
              page_start NULLS LAST,
              created_at ASC`,
    [String(documentId)]
  );
  return (res.rows || []).map((r: any) => ({
    type: r.type === 'full' ? 'full' : 'section',
    sectionId: r.section_id ?? null,
    sectionName: r.section_name ?? null,
    pageStart: r.page_start ?? null,
    pageEnd: r.page_end ?? null,
    summary: String(r.summary || ''),
    promptVersion: r.prompt_version ?? null,
    needsReview: Boolean(r.needs_review),
    version: Number(r.version) || 1,
  }));
}

/** Latest full-document overview only (`type=full`). */
export async function getFullSummary(
  documentId: DocumentId
): Promise<StoredSummaryRow | null> {
  const rows = await listSummaries(documentId);
  return rows.find((r) => r.type === 'full' && r.summary.trim()) ?? null;
}

/** True if we already posted this document's full summary into the chat. */
export async function hasPostedDocumentFullSummary(
  conversationId: string,
  documentId: DocumentId
): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1
     FROM conversation_messages
     WHERE conversation_id = $1::uuid
       AND role = 'assistant'
       AND metadata->>'source' = 'document_full_summary'
       AND metadata->>'documentId' = $2
     LIMIT 1`,
    [conversationId, String(documentId)]
  );
  return Boolean(res.rows[0]);
}

export type FaqCategoryCount = {
  id: string;
  name: string;
  questionCount: number;
};

/**
 * Browse scope for chat FAQ chips: this document's FAQs plus any FAQs
 * keyed to the same policy_id (metadata.policy_id).
 */
export async function resolveFaqBrowseScope(documentId: DocumentId): Promise<{
  documentId: string;
  policyId: string | null;
}> {
  const doc = await getDocument(documentId);
  return {
    documentId: String(documentId),
    policyId: (doc?.policy_id || '').trim() || null,
  };
}

/** Active FAQ rows for a document and/or its policy_id. */
function faqBrowseScopeSql(
  alias: string,
  documentParam: number,
  policyParam: number | null
): string {
  const active = `
    COALESCE(${alias}.active, true) = true
    AND COALESCE(${alias}.status::text, 'pending') <> 'rejected'`;
  if (policyParam == null) {
    return `${active} AND ${alias}.document_id = $${documentParam}`;
  }
  return `${active} AND (
    ${alias}.document_id = $${documentParam}
    OR ${alias}.metadata->>'policy_id' = $${policyParam}
  )`;
}

/**
 * Top FAQ categories by question count for this document + policy.
 * Prefers faq_categories join; falls back to metadata.category_name when
 * category_id is null (common when "other" / unmatched names are stored).
 */
export async function getTopFaqCategories(
  documentId: DocumentId,
  limit = 3
): Promise<FaqCategoryCount[]> {
  const scope = await resolveFaqBrowseScope(documentId);
  const params: unknown[] = [scope.documentId];
  const policyParam = scope.policyId ? 2 : null;
  if (scope.policyId) params.push(scope.policyId);
  params.push(limit);
  const limitParam = params.length;

  try {
    const res = await pool.query(
      `SELECT
         COALESCE(
           c.id::text,
           'name:' || lower(COALESCE(NULLIF(trim(f.metadata->>'category_name'), ''), 'other'))
         ) AS id,
         COALESCE(
           NULLIF(trim(c.name), ''),
           NULLIF(trim(f.metadata->>'category_name'), ''),
           'Other'
         ) AS name,
         COUNT(*)::int AS question_count
       FROM faqs f
       LEFT JOIN faq_categories c ON c.id = f.category_id
       WHERE ${faqBrowseScopeSql('f', 1, policyParam)}
       GROUP BY 1, 2
       ORDER BY question_count DESC, name ASC
       LIMIT $${limitParam}`,
      params
    );
    return res.rows
      .map((r) => ({
        id: String(r.id),
        name: String(r.name || '').trim(),
        questionCount: Number(r.question_count) || 0,
      }))
      .filter((r) => r.name && r.questionCount > 0);
  } catch {
    // faq_categories / metadata may be missing on older schemas
    return [];
  }
}

export type BrowseFaqRow = {
  id: string;
  document_id: string;
  document_name: string | null;
  version: number;
  type: string;
  scope: string | null;
  status: string | null;
  active: boolean | null;
  category_id: string | null;
  category_name?: string | null;
  question: string;
  answer: string;
  section_id: string | null;
  section_name: string | null;
  page_refs: number[] | null;
  position: number | null;
  prompt_version: string | null;
  created_at: Date;
};

/** Latest customer document bound to a chat session (conversation id). */
export async function findLatestDocumentBySessionId(
  sessionId: string
): Promise<DocumentRow | null> {
  const id = (sessionId || '').trim();
  if (!isDocumentUuid(id)) return null;
  const res = await pool.query(
    `SELECT * FROM documents
     WHERE session_id = $1
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [id]
  );
  return res.rows[0] ?? null;
}

/** Flattened interpret fields from document_policy_refs.refs (for chat scoping). */
export type DocumentPolicyRefRow = {
  document_id: string;
  policy_id: string | null;
  policy_number: string | null;
  policy_name: string | null;
  company_name: string | null;
  insurer_name: string | null;
  categories: string | null;
  refs: Record<string, unknown>;
};

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t || null;
}

/** Policy interpret refs for a document, flattened for chat/Haystack filters. */
export async function findDocRefByDocumentId(
  documentId: string
): Promise<DocumentPolicyRefRow | null> {
  const id = (documentId || '').trim();
  if (!isDocumentUuid(id)) return null;
  const res = await pool.query(
    `SELECT document_id::text AS document_id, refs
     FROM document_policy_refs
     WHERE document_id = $1
     LIMIT 1`,
    [id]
  );
  const row = res.rows[0] as
    | { document_id: string; refs: unknown }
    | undefined;
  if (!row) return null;

  const refs =
    row.refs && typeof row.refs === 'object' && !Array.isArray(row.refs)
      ? (row.refs as Record<string, unknown>)
      : {};

  const policyNumber =
    strOrNull(refs.policy_number) || strOrNull(refs.policy_id);
  const categoriesRaw = refs.categories;
  const categories =
    typeof categoriesRaw === 'string'
      ? strOrNull(categoriesRaw)
      : Array.isArray(categoriesRaw)
        ? strOrNull(
            categoriesRaw
              .filter((c): c is string => typeof c === 'string' && c.trim() !== '')
              .join(',')
          )
        : null;

  return {
    document_id: row.document_id,
    policy_id: policyNumber,
    policy_number: policyNumber,
    policy_name: strOrNull(refs.policy_name),
    company_name: strOrNull(refs.company_name),
    insurer_name: strOrNull(refs.insurer_name),
    categories,
    refs,
  };
}

/**
 * Top FAQs for a category name, scoped to the session document and its policy_id.
 * Matches faq_categories.name or metadata.category_name (case-insensitive).
 */
export async function listTopFaqsByCategoryName(opts: {
  documentId: DocumentId;
  categoryName: string;
  policyId?: string | null;
  limit?: number;
}): Promise<BrowseFaqRow[]> {
  const category = opts.categoryName.trim();
  if (!category) return [];

  const docId = String(opts.documentId);
  const policyId =
    (opts.policyId || '').trim() ||
    (await resolveFaqBrowseScope(opts.documentId)).policyId;
  const limit =
    Number.isFinite(opts.limit) && (opts.limit as number) > 0
      ? Math.min(Math.floor(opts.limit as number), 20)
      : 3;

  const params: unknown[] = [docId];
  const policyParam = policyId ? 2 : null;
  if (policyId) params.push(policyId);
  params.push(category.toLowerCase());
  const catParam = params.length;
  params.push(limit);
  const limitParam = params.length;

  const res = await pool.query(
    `SELECT f.id::text AS id, f.document_id, f.document_name, f.version,
            f.type::text AS type,
            CASE WHEN f.type::text = 'general' THEN 'global' ELSE 'specific' END AS scope,
            f.status::text AS status, f.active,
            f.category_id::text AS category_id,
            COALESCE(
              NULLIF(trim(c.name), ''),
              NULLIF(trim(f.metadata->>'category_name'), '')
            ) AS category_name,
            f.question, f.answer, f.section_id, f.section AS section_name,
            f.pages AS page_refs, f.position, f.prompt_version, f.created_at
     FROM faqs f
     LEFT JOIN faq_categories c ON c.id = f.category_id
     WHERE ${faqBrowseScopeSql('f', 1, policyParam)}
       AND (
         lower(trim(COALESCE(c.name, ''))) = $${catParam}
         OR lower(trim(COALESCE(f.metadata->>'category_name', ''))) = $${catParam}
       )
     ORDER BY f.position ASC, f.created_at ASC
     LIMIT $${limitParam}`,
    params
  );
  return res.rows as BrowseFaqRow[];
}

/** List FAQs for chat browse: document-specific and/or policy-id specific. */
export async function listFaqsForBrowse(opts: {
  documentId: DocumentId;
  categoryId?: string | null;
  limit?: number | null;
}): Promise<{ documentId: string; policyId: string | null; faqs: BrowseFaqRow[] }> {
  const scope = await resolveFaqBrowseScope(opts.documentId);
  const params: unknown[] = [scope.documentId];
  const policyParam = scope.policyId ? 2 : null;
  if (scope.policyId) params.push(scope.policyId);

  let where = `WHERE ${faqBrowseScopeSql('f', 1, policyParam)}`;

  if (opts.categoryId) {
    if (opts.categoryId.startsWith('name:')) {
      const nameKey = opts.categoryId.slice('name:'.length).trim().toLowerCase();
      params.push(nameKey);
      where += ` AND lower(COALESCE(NULLIF(trim(f.metadata->>'category_name'), ''), 'other')) = $${params.length}`;
    } else {
      params.push(opts.categoryId);
      where += ` AND f.category_id = $${params.length}::uuid`;
    }
  }

  let sql = `
    SELECT f.id::text AS id, f.document_id, f.document_name, f.version,
           f.type::text AS type,
           CASE WHEN f.type::text = 'general' THEN 'global' ELSE 'specific' END AS scope,
           f.status::text AS status, f.active,
           f.category_id::text AS category_id,
           f.question, f.answer, f.section_id, f.section AS section_name,
           f.pages AS page_refs, f.position, f.prompt_version, f.created_at
    FROM faqs f
    ${where}
    ORDER BY f.position ASC, f.created_at ASC`;

  if (opts.limit != null && opts.limit > 0) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const res = await pool.query(sql, params);
  return {
    documentId: scope.documentId,
    policyId: scope.policyId,
    faqs: res.rows as BrowseFaqRow[],
  };
}

/** True if we already posted FAQ category chips for this document. */
export async function hasPostedDocumentFaqCategories(
  conversationId: string,
  documentId: DocumentId
): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1
     FROM conversation_messages
     WHERE conversation_id = $1::uuid
       AND role = 'assistant'
       AND metadata->>'source' = 'document_faq_categories'
       AND metadata->>'documentId' = $2
     LIMIT 1`,
    [conversationId, String(documentId)]
  );
  return Boolean(res.rows[0]);
}

/** Matches app-api chat_sessions (user_id/title dropped in 0007). */
export async function findActiveChatSession(
  sessionId: string
): Promise<{ id: string; active: boolean } | null> {
  if (!isDocumentUuid(sessionId)) return null;
  const res = await pool.query(
    `SELECT id::text AS id, active
     FROM chat_sessions
     WHERE id = $1
     LIMIT 1`,
    [sessionId]
  );
  return res.rows[0] ?? null;
}

export async function createDocument(input: {
  location: string;
  source: DocumentSource;
  priority: number;
  fileName: string;
  fileHash?: string;
  fileId?: string | null;
  fileType?: string | null;
  fileSize?: number | null;
  policyId?: string | null;
  sessionId?: string | null;
}): Promise<DocumentRow> {
  // Shared product schema (app-api): document_id + file_name are NOT NULL.
  // document_id mirrors id (UUID string) — FAQs/summaries join on that value.
  // Multiple sources may share the same file_id (no global file_hash unique on documents).
  const res = await pool.query(
    `WITH new_id AS (SELECT gen_random_uuid() AS id)
     INSERT INTO documents (
       id, document_id, file_name, file_type, file_size, file_hash, file_id,
       policy_id, session_id, generation_status,
       location, status, pipeline_step, pipeline_status, source, priority,
       chat_ready, retry_count, retry_limit, created_at, updated_at
     )
     SELECT
       new_id.id, new_id.id::text, $4, $5, $6, $7, $8,
       $9, $10, 'generating'::document_status,
       $1, 'pending', 'uploaded', 'queued', $2, $3,
       false, 0, $11, NOW(), NOW()
     FROM new_id
     RETURNING *`,
    [
      input.location,
      input.source,
      input.priority,
      input.fileName,
      input.fileType ?? null,
      input.fileSize ?? null,
      input.fileHash ?? null,
      input.fileId ?? null,
      input.policyId?.trim() || null,
      input.sessionId?.trim() || null,
      pipelineConfig.retryLimit,
    ]
  );
  return res.rows[0];
}

/**
 * Set documents.policy_id when a non-null policy id/number is found.
 * Does not overwrite an existing non-null policy_id.
 */
export async function updateDocumentPolicyId(
  documentId: DocumentId,
  policyId: string | null | undefined
): Promise<boolean> {
  const value = typeof policyId === 'string' ? policyId.trim() : '';
  if (!value) return false;
  const res = await pool.query(
    `UPDATE documents
     SET policy_id = $2, updated_at = NOW()
     WHERE id = $1 AND (policy_id IS NULL OR trim(policy_id) = '')
     RETURNING id`,
    [documentId, value.slice(0, 200)]
  );
  return (res.rowCount ?? 0) > 0;
}

export function stepIndex(step: PipelineStep | null | undefined): number {
  if (!step) return -1;
  return PIPELINE_STEPS.indexOf(step);
}

export function isStepDone(
  current: PipelineStep | null | undefined,
  target: PipelineStep
): boolean {
  const cur = current ? PIPELINE_STEPS.indexOf(current) : -1;
  const tgt = PIPELINE_STEPS.indexOf(target);
  return cur >= tgt;
}
