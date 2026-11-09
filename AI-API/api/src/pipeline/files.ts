/**
 * Content-addressed shared files + processing compatibility helpers.
 */
import fs from 'fs';
import path from 'path';
import pool from '../db';
import type { DocumentId, DocumentSource } from './types';
import type { DocumentRow } from './repository';

export type FileRow = {
  id: string;
  file_hash: string;
  storage_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: Date;
  updated_at: Date;
};

export type DocumentProcessingRow = {
  id: string;
  file_id: string;
  donor_document_id: string | null;
  processing_version: string;
  embedding_model: string;
  chunking_version: string;
  status: string;
};

export function contentAddressedRelPath(fileHash: string): string {
  const prefix = fileHash.slice(0, 2);
  return path.join('uploads', 'by-hash', prefix, fileHash).replace(/\\/g, '/');
}

export function absFromRel(relOrAbs: string): string {
  if (!relOrAbs || relOrAbs === '[purged]') return '';
  return path.isAbsolute(relOrAbs)
    ? relOrAbs
    : path.join(process.cwd(), relOrAbs);
}

/** Current embedding + chunking fingerprint used for reuse checks. */
export function currentProcessingFingerprint(): {
  processingVersion: string;
  embeddingModel: string;
  chunkingVersion: string;
} {
  const embeddingModel =
    process.env.INGEST_EMBEDDING_MODEL?.trim() ||
    process.env.EMBEDDING_MODEL?.trim() ||
    'default';
  const chunkSize = process.env.CHUNK_SIZE?.trim() || '800';
  const chunkOverlap = process.env.CHUNK_OVERLAP?.trim() || '120';
  return {
    processingVersion: process.env.PROCESSING_VERSION?.trim() || 'v1',
    embeddingModel,
    chunkingVersion: `${chunkSize}-${chunkOverlap}`,
  };
}

/**
 * Atomically upsert a shared file by SHA-256.
 * Moves tempPath into content-addressed storage when creating a new row.
 * Deletes tempPath when reusing an existing file.
 */
export async function upsertSharedFile(input: {
  fileHash: string;
  tempPath: string;
  fileSize?: number | null;
  mimeType?: string | null;
}): Promise<{ file: FileRow; created: boolean }> {
  const hash = input.fileHash.trim().toLowerCase();
  if (!hash) throw new Error('fileHash is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent uploads of the same hash.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [hash]);

    const existing = await client.query(
      `SELECT * FROM files WHERE file_hash = $1 LIMIT 1`,
      [hash]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      // Drop the duplicate upload bytes.
      try {
        if (fs.existsSync(input.tempPath)) fs.unlinkSync(input.tempPath);
      } catch {
        /* ignore */
      }
      return { file: existing.rows[0] as FileRow, created: false };
    }

    const rel = contentAddressedRelPath(hash);
    const abs = absFromRel(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (path.resolve(input.tempPath) !== path.resolve(abs)) {
      fs.renameSync(input.tempPath, abs);
    }

    const inserted = await client.query(
      `INSERT INTO files (file_hash, storage_path, file_size, mime_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (file_hash) DO UPDATE
         SET updated_at = NOW()
       RETURNING *`,
      [hash, rel, input.fileSize ?? null, input.mimeType ?? null]
    );
    await client.query('COMMIT');
    return { file: inserted.rows[0] as FileRow, created: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getFileById(fileId: string): Promise<FileRow | null> {
  const res = await pool.query(`SELECT * FROM files WHERE id = $1`, [fileId]);
  return res.rows[0] ?? null;
}

export async function getFileByHash(fileHash: string): Promise<FileRow | null> {
  const res = await pool.query(
    `SELECT * FROM files WHERE file_hash = $1 LIMIT 1`,
    [fileHash.trim().toLowerCase()]
  );
  return res.rows[0] ?? null;
}

export async function countDocumentsForFile(fileId: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM documents WHERE file_id = $1`,
    [fileId]
  );
  return Number(res.rows[0]?.n || 0);
}

/**
 * Delete files row + disk path only when no documents reference it.
 * Returns whether the physical file was removed.
 */
export async function deleteFileIfUnreferenced(
  fileId: string | null | undefined,
  fallbackLocation?: string | null
): Promise<boolean> {
  if (!fileId) {
    // Legacy row without file_id — only unlink if location unique (best-effort).
    const loc = (fallbackLocation || '').trim();
    if (!loc || loc === '[purged]') return false;
    const refs = await pool.query(
      `SELECT COUNT(*)::int AS n FROM documents
       WHERE location = $1`,
      [loc]
    );
    if (Number(refs.rows[0]?.n || 0) > 0) return false;
    const abs = absFromRel(loc);
    try {
      if (abs && fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  const n = await countDocumentsForFile(fileId);
  if (n > 0) return false;

  const file = await getFileById(fileId);
  if (!file) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM files WHERE id = $1`, [fileId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const abs = absFromRel(file.storage_path);
  try {
    if (abs && fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Latest document association for this file + source (+ optional policy). */
export async function findDocumentByFileId(
  fileId: string,
  source: DocumentSource,
  policyId?: string | null
): Promise<DocumentRow | null> {
  const policy = (policyId || '').trim();
  const res = policy
    ? await pool.query(
        `SELECT * FROM documents
         WHERE file_id = $1 AND source = $2 AND policy_id = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [fileId, source, policy]
      )
    : await pool.query(
        `SELECT * FROM documents
         WHERE file_id = $1 AND source = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [fileId, source]
      );
  return res.rows[0] ?? null;
}

export async function findCompatibleProcessing(
  fileId: string
): Promise<DocumentProcessingRow | null> {
  const fp = currentProcessingFingerprint();
  const res = await pool.query(
    `SELECT * FROM document_processing
     WHERE file_id = $1
       AND processing_version = $2
       AND embedding_model = $3
       AND chunking_version = $4
       AND status = 'completed'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [fileId, fp.processingVersion, fp.embeddingModel, fp.chunkingVersion]
  );
  return res.rows[0] ?? null;
}

export async function upsertDocumentProcessing(input: {
  fileId: string;
  donorDocumentId: DocumentId;
}): Promise<DocumentProcessingRow> {
  const fp = currentProcessingFingerprint();
  const res = await pool.query(
    `INSERT INTO document_processing (
       file_id, donor_document_id, processing_version, embedding_model,
       chunking_version, status, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'completed', NOW())
     ON CONFLICT (file_id, processing_version, embedding_model, chunking_version)
     DO UPDATE SET
       donor_document_id = COALESCE(EXCLUDED.donor_document_id, document_processing.donor_document_id),
       status = 'completed',
       updated_at = NOW()
     RETURNING *`,
    [
      input.fileId,
      input.donorDocumentId,
      fp.processingVersion,
      fp.embeddingModel,
      fp.chunkingVersion,
    ]
  );
  return res.rows[0];
}

/** Find another document with the same file_id that already has extracted pages. */
export async function findPageDonorForFile(
  fileId: string,
  excludeDocumentId?: DocumentId
): Promise<DocumentId | null> {
  const res = await pool.query(
    `SELECT d.id
     FROM documents d
     WHERE d.file_id = $1
       AND ($2::uuid IS NULL OR d.id <> $2::uuid)
       AND EXISTS (
         SELECT 1 FROM document_pages p
         WHERE p.document_id = d.id AND p.status = 'done'
         LIMIT 1
       )
     ORDER BY d.updated_at DESC
     LIMIT 1`,
    [fileId, excludeDocumentId ?? null]
  );
  return res.rows[0]?.id ?? null;
}

/** Copy pages + policy refs from donor → target (overwrite target pages). */
export async function copyExtractArtifacts(
  donorDocumentId: DocumentId,
  targetDocumentId: DocumentId
): Promise<{ pagesCopied: number; refsCopied: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM document_pages WHERE document_id = $1`, [
      targetDocumentId,
    ]);
    const pages = await client.query(
      `INSERT INTO document_pages (
         document_id, page_number, text, layout_json, elements_json,
         ocr_confidence, status, created_at, updated_at
       )
       SELECT $2, page_number, text, layout_json, elements_json,
              ocr_confidence, status, NOW(), NOW()
       FROM document_pages
       WHERE document_id = $1
       RETURNING id`,
      [donorDocumentId, targetDocumentId]
    );

    let refsCopied = false;
    const refs = await client.query(
      `SELECT refs FROM document_policy_refs WHERE document_id = $1`,
      [donorDocumentId]
    );
    if (refs.rows[0]) {
      await client.query(
        `INSERT INTO document_policy_refs (document_id, refs, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (document_id)
         DO UPDATE SET refs = EXCLUDED.refs, updated_at = NOW()`,
        [targetDocumentId, JSON.stringify(refs.rows[0].refs)]
      );
      refsCopied = true;
    }

    const pageCount = pages.rowCount ?? 0;
    if (pageCount > 0) {
      await client.query(
        `UPDATE documents
         SET page_count = $2, updated_at = NOW()
         WHERE id = $1`,
        [targetDocumentId, pageCount]
      );
    }

    await client.query('COMMIT');
    return { pagesCopied: pageCount, refsCopied };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Resolve on-disk path for a document (files.storage_path preferred). */
export async function resolveDocumentFilePath(
  doc: Pick<DocumentRow, 'file_id' | 'location'>
): Promise<string> {
  if (doc.file_id) {
    const file = await getFileById(doc.file_id);
    if (file?.storage_path) {
      const abs = absFromRel(file.storage_path);
      if (abs && fs.existsSync(abs)) return abs;
    }
  }
  return absFromRel(doc.location || '');
}
