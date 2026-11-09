import pool from '../db';
import { qdrantClient } from '../integrations/qdrant/qdrant.client';
import { pipelineConfig } from './config';
import { deleteFileIfUnreferenced } from './files';
import { qdrantCollectionForSource } from './handlers/vector';
import type { DocumentId, DocumentSource } from './types';
import { addEvent, type DocumentRow } from './repository';

const PURGED_LOCATION = '[purged]';

/** Delete Qdrant points tagged with this document id (chunks + summary vectors). */
async function deleteQdrantForDocument(
  documentId: DocumentId,
  source: DocumentSource
): Promise<void> {
  const collection = qdrantCollectionForSource(source);
  const id = String(documentId);
  try {
    await qdrantClient.delete(collection, {
      wait: true,
      filter: {
        should: [
          {
            key: "meta.document_id",
            match: { value: id },
          },
          {
            key: "meta.original_document_id",
            match: { value: id },
          },
        ],
      },
    });
  } catch (err) {
    // Missing collection / points is fine — log and continue.
    console.warn(
      `[retention] qdrant delete failed collection=${collection} doc=${id}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/** Delete FAQ rows (and legacy document_faqs) for a document. */
async function deleteFaqsForDocument(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }> },
  documentId: DocumentId
): Promise<number> {
  const id = String(documentId);
  let deleted = 0;

  const faqRes = await client.query(`DELETE FROM faqs WHERE document_id = $1`, [
    id,
  ]);
  deleted += Number(faqRes.rowCount || 0);

  await client.query('SAVEPOINT legacy_faqs');
  try {
    const legacyRes = await client.query(
      `DELETE FROM document_faqs WHERE document_id = $1`,
      [documentId]
    );
    deleted += Number(legacyRes.rowCount || 0);
    await client.query('RELEASE SAVEPOINT legacy_faqs');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT legacy_faqs');
  }

  console.log(`[retention] faqs deleted doc=${id} count=${deleted}`);
  return deleted;
}

async function findExpiredBySource(
  source: DocumentSource,
  olderThanDays: number,
  opts?: { fileStillPresent?: boolean }
): Promise<DocumentRow[]> {
  if (olderThanDays <= 0) return [];
  const params: unknown[] = [source, String(olderThanDays)];
  let sql = `
    SELECT * FROM documents
    WHERE source = $1
      AND created_at < NOW() - ($2::text || ' days')::interval`;
  if (opts?.fileStillPresent) {
    sql += `
      AND location IS NOT NULL
      AND trim(location) <> ''
      AND location <> '${PURGED_LOCATION}'`;
  }
  sql += `
    ORDER BY created_at ASC
    LIMIT 100`;
  const res = await pool.query(sql, params);
  return res.rows as DocumentRow[];
}

/**
 * Full purge: Qdrant vectors → FAQs/summaries/pipeline rows → document → file.
 * Used by retention (customer) and by admin DELETE /documents/:id.
 */
export async function purgeDocumentFully(
  doc: DocumentRow
): Promise<{
  ok: boolean;
  detail: string;
  fileRemoved: boolean;
  faqsDeleted: number;
}> {
  const id = doc.id;
  const source = (doc.source || 'admin') as DocumentSource;

  // 1) Vectors first (outside DB txn — remote call).
  await deleteQdrantForDocument(id, source);

  // 2) FAQs + related Postgres rows, then document.
  let faqsDeleted = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    faqsDeleted = await deleteFaqsForDocument(client, id);

    await client.query(`DELETE FROM document_pages WHERE document_id = $1`, [id]);
    await client.query(
      `DELETE FROM document_policy_refs WHERE document_id = $1`,
      [id]
    );
    await client.query(
      `DELETE FROM document_pipeline_events WHERE document_id = $1`,
      [id]
    );

    await client.query('SAVEPOINT clear_summaries');
    try {
      await client.query(`DELETE FROM summaries WHERE document_id = $1`, [
        String(id),
      ]);
      await client.query('RELEASE SAVEPOINT clear_summaries');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT clear_summaries');
    }

    await client.query('SAVEPOINT legacy_summaries');
    try {
      await client.query(
        `DELETE FROM document_summaries WHERE document_id = $1`,
        [id]
      );
      await client.query('RELEASE SAVEPOINT legacy_summaries');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT legacy_summaries');
    }

    await client.query(`DELETE FROM documents WHERE id = $1`, [id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // 3) Shared file last — only if no other document associations remain.
  const fileRemoved = await deleteFileIfUnreferenced(
    doc.file_id,
    doc.location
  );
  return {
    ok: true,
    fileRemoved,
    faqsDeleted,
    detail:
      `${source} full purge (faqs_deleted=${faqsDeleted}, ` +
      `file_removed=${fileRemoved}, file_id=${doc.file_id || 'none'})`,
  };
}

/**
 * Customer: wipe file + vectors + FAQs/summaries + pipeline artifact tables + document row.
 */
export async function purgeCustomerDocument(
  doc: DocumentRow
): Promise<{ ok: boolean; detail: string }> {
  const out = await purgeDocumentFully(doc);
  return { ok: out.ok, detail: out.detail };
}

/**
 * Admin/folder: mark this association's location purged; delete physical file
 * only when no other documents still reference the shared file_id.
 */
export async function purgeAdminFileOnly(
  doc: DocumentRow
): Promise<{ ok: boolean; detail: string }> {
  await pool.query(
    `UPDATE documents
     SET location = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [doc.id, PURGED_LOCATION]
  );

  let removed = false;
  if (doc.file_id) {
    // Keep shared bytes while any other association still needs the path.
    const others = await pool.query(
      `SELECT COUNT(*)::int AS n FROM documents
       WHERE file_id = $1
         AND id <> $2
         AND location IS NOT NULL
         AND trim(location) <> ''
         AND location <> $3`,
      [doc.file_id, doc.id, PURGED_LOCATION]
    );
    if (Number(others.rows[0]?.n || 0) === 0) {
      const fileId = doc.file_id;
      // Detach so refcount drops, then delete physical file + files row.
      await pool.query(
        `UPDATE documents SET file_id = NULL, updated_at = NOW() WHERE id = $1`,
        [doc.id]
      );
      removed = await deleteFileIfUnreferenced(fileId, doc.location);
    }
  } else {
    removed = await deleteFileIfUnreferenced(null, doc.location);
  }

  try {
    await addEvent(doc.id, 'uploaded', 'Retention: admin upload file purged', {
      mode: 'admin_file_only',
      fileRemoved: removed,
      previousLocation: doc.location,
      fileId: doc.file_id ?? undefined,
    });
  } catch {
    /* events table optional */
  }
  return {
    ok: true,
    detail: `admin file-only purge (file_removed=${removed})`,
  };
}

export type RetentionPassResult = {
  customerPurged: number;
  adminFilesPurged: number;
  errors: number;
};

/**
 * One retention pass. Safe to run on an interval from the document worker.
 */
export async function runRetentionPass(): Promise<RetentionPassResult> {
  const result: RetentionPassResult = {
    customerPurged: 0,
    adminFilesPurged: 0,
    errors: 0,
  };

  if (!pipelineConfig.retentionEnabled) {
    return result;
  }

  const customerDays = pipelineConfig.retentionCustomerDays;
  const adminDays = pipelineConfig.retentionAdminFileDays;

  if (customerDays > 0) {
    const docs = await findExpiredBySource('customer', customerDays);
    for (const doc of docs) {
      try {
        const out = await purgeCustomerDocument(doc);
        result.customerPurged += 1;
        console.log(
          `[retention] customer doc=${doc.id} age_days>=${customerDays} ${out.detail}`
        );
      } catch (err) {
        result.errors += 1;
        console.error(
          `[retention] customer purge failed doc=${doc.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  if (adminDays > 0) {
    for (const source of ['admin', 'folder'] as const) {
      const docs = await findExpiredBySource(source, adminDays, {
        fileStillPresent: true,
      });
      for (const doc of docs) {
        try {
          const out = await purgeAdminFileOnly(doc);
          result.adminFilesPurged += 1;
          console.log(
            `[retention] ${source} doc=${doc.id} age_days>=${adminDays} ${out.detail}`
          );
        } catch (err) {
          result.errors += 1;
          console.error(
            `[retention] ${source} file purge failed doc=${doc.id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  }

  return result;
}

export function startRetentionLoop(): NodeJS.Timeout | null {
  if (!pipelineConfig.retentionEnabled) {
    console.log('[retention] disabled (RETENTION_ENABLED=false)');
    return null;
  }

  const { retentionCustomerDays, retentionAdminFileDays, retentionIntervalMs } =
    pipelineConfig;

  if (retentionCustomerDays <= 0 && retentionAdminFileDays <= 0) {
    console.log(
      '[retention] disabled (RETENTION_CUSTOMER_DAYS and RETENTION_ADMIN_FILE_DAYS are 0)'
    );
    return null;
  }

  console.log(
    `[retention] every ${retentionIntervalMs}ms; ` +
      `customer_full=${retentionCustomerDays}d; ` +
      `admin_file_only=${retentionAdminFileDays}d`
  );

  // First pass shortly after boot (after reconcile).
  setTimeout(() => {
    runRetentionPass()
      .then((r) => {
        if (r.customerPurged || r.adminFilesPurged || r.errors) {
          console.log('[retention] boot pass', r);
        }
      })
      .catch((err) => console.error('[retention] boot pass failed', err));
  }, 60_000);

  return setInterval(() => {
    runRetentionPass()
      .then((r) => {
        if (r.customerPurged || r.adminFilesPurged || r.errors) {
          console.log('[retention] pass', r);
        }
      })
      .catch((err) => console.error('[retention] pass failed', err));
  }, retentionIntervalMs);
}
