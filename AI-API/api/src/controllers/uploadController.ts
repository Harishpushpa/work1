import { Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { notifyCustomerReuseToChat } from '../pipeline/handlers/chat-notify';
import {
  upsertSharedFile,
} from '../pipeline/files';
import {
  addEvent,
  createDocument,
  findActiveChatSession,
  findByFileHash,
  getFullSummary,
  resetDocumentForReprocess,
  updateDocumentSessionId,
  type DocumentRow,
} from '../pipeline/repository';
import {
  DOCUMENT_SOURCES,
  isDocumentUuid,
  type DocumentSource,
} from '../pipeline/types';
import {
  enqueueDocumentJob,
  priorityValueForSource,
  queueNameForSource,
} from '../queues/queue';

const UPLOAD_ROOT =
  process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

function createStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const folder = (req.body && (req.body.folder as string)) || 'default';
      const dest = path.join(UPLOAD_ROOT, folder);
      fs.mkdirSync(dest, { recursive: true });
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  });
}

export const uploadMiddleware = multer({ storage: createStorage() });

function resolveSource(req: Request): DocumentSource {
  const raw = String(
    req.body?.source || req.headers['x-document-source'] || 'admin'
  )
    .trim()
    .toLowerCase();
  if ((DOCUMENT_SOURCES as readonly string[]).includes(raw)) {
    return raw as DocumentSource;
  }
  return 'admin';
}

function resolveForce(req: Request): boolean {
  const raw = String(
    req.body?.force ?? req.query?.force ?? 'false'
  ).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function resolvePolicyId(req: Request): string | null {
  const raw = String(
    req.body?.policy_id ?? req.body?.policyId ?? req.headers['x-policy-id'] ?? ''
  ).trim();
  return raw || null;
}

function resolveSessionId(req: Request): string | null {
  const raw = String(
    req.body?.session_id ??
      req.body?.sessionId ??
      req.headers['x-session-id'] ??
      ''
  ).trim();
  return raw || null;
}

function fileHashSync(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function policyIdsMatch(
  existing: DocumentRow,
  policyId: string | null
): boolean {
  const a = (existing.policy_id || '').trim();
  const b = (policyId || '').trim();
  if (!b) return true; // no policy on request → hash+source match is enough
  return a === b;
}

/** Customer reuse only when pipeline finished and a full summary exists. */
async function canReuseCustomerDocument(
  existing: DocumentRow
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (existing.pipeline_status !== 'completed' || !existing.chat_ready) {
    return {
      ok: false,
      reason: `status=${existing.pipeline_status}, chat_ready=${existing.chat_ready}`,
    };
  }
  const full = await getFullSummary(existing.id);
  if (!full?.summary?.trim()) {
    return { ok: false, reason: 'no_full_summary' };
  }
  return { ok: true };
}

/**
 * Upload files with content-addressed shared storage.
 * - One physical file per SHA-256 (`files` table).
 * - Separate `documents` rows per source (admin | folder | customer).
 * - Customer same hash+policy completed → reuse row + re-post summary (1B).
 * - Cross-source never reuses ownership; creates a new association on the shared file.
 */
export async function uploadFiles(req: Request, res: Response) {
  try {
    const uploaded = req.files as Express.Multer.File[] | undefined;
    if (!uploaded || uploaded.length === 0) {
      return res
        .status(400)
        .json({ error: 'No files uploaded. Send files under field "files".' });
    }

    const source = resolveSource(req);
    const force = resolveForce(req);
    const policyId = resolvePolicyId(req);
    const sessionId = resolveSessionId(req);
    const priority = priorityValueForSource(source);

    if (source === 'customer') {
      if (!sessionId) {
        return res.status(400).json({
          error: 'session_id is required for customer uploads',
        });
      }
      if (!isDocumentUuid(sessionId)) {
        return res.status(400).json({
          error: 'session_id must be a valid UUID',
        });
      }
      const session = await findActiveChatSession(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'session_id not found',
        });
      }
      if (!session.active) {
        return res.status(400).json({
          error: 'session_id is not active',
        });
      }
    }

    const documents: Array<{
      id: string;
      location: string;
      fileId: string;
      jobId: string | undefined;
      queue: string;
      source: DocumentSource;
      sessionId: string | null;
      pipelineStatus: string;
      duplicate: boolean;
      forced: boolean;
      reused?: boolean;
      chatNotified?: boolean;
      sharedFile?: boolean;
    }> = [];

    for (const f of uploaded) {
      const hash = fileHashSync(f.path);
      const { file, created: fileCreated } = await upsertSharedFile({
        fileHash: hash,
        tempPath: f.path,
        fileSize: f.size ?? null,
        mimeType: f.mimetype || null,
      });
      const location = file.storage_path;

      // Same-source association (customer scoped by policy when provided).
      const existing = await findByFileHash(
        hash,
        source,
        source === 'customer' ? policyId : null
      );

      // 1B: Customer completed same hash+policy → reuse row, rebind session, notify.
      if (
        source === 'customer' &&
        existing &&
        !force &&
        policyIdsMatch(existing, policyId)
      ) {
        const reuse = await canReuseCustomerDocument(existing);
        if (reuse.ok) {
          await updateDocumentSessionId(existing.id, sessionId);
          const notified = await notifyCustomerReuseToChat(
            existing.id,
            sessionId!
          );
          await addEvent(
            existing.id,
            'completed',
            'Customer reupload reused completed document (summary only)',
            {
              sessionId,
              policyId: policyId ?? existing.policy_id ?? undefined,
              summaryPosted: notified.summaryPosted,
              mode: 'reuse',
              fileId: file.id,
            }
          );
          documents.push({
            id: existing.id,
            location: existing.location || location,
            fileId: file.id,
            jobId: undefined,
            queue: queueNameForSource(existing.source),
            source: existing.source,
            sessionId,
            pipelineStatus: existing.pipeline_status,
            duplicate: true,
            forced: false,
            reused: true,
            chatNotified: notified.summaryPosted,
            sharedFile: !fileCreated,
          });
          continue;
        }

        console.log(
          `[upload] customer hash hit but not reusable doc=${existing.id} (${reuse.reason}); restarting`
        );
      }

      const customerNeedsRestart =
        source === 'customer' &&
        Boolean(existing) &&
        !force &&
        policyIdsMatch(existing!, policyId);

      const startOver =
        Boolean(force) ||
        (Boolean(existing) && existing!.pipeline_status === 'failed') ||
        customerNeedsRestart;

      // Same-source in-progress / completed (admin/folder): skip unless force/failed.
      if (existing && !startOver) {
        documents.push({
          id: existing.id,
          location: existing.location || location,
          fileId: file.id,
          jobId: undefined,
          queue: queueNameForSource(existing.source),
          source: existing.source,
          sessionId: existing.session_id ?? null,
          pipelineStatus: existing.pipeline_status,
          duplicate: true,
          forced: false,
          sharedFile: !fileCreated,
        });
        continue;
      }

      let doc = existing;
      if (existing && startOver) {
        doc = await resetDocumentForReprocess(existing.id, {
          location,
          fileName: f.originalname,
          fileHash: hash,
          fileId: file.id,
          fileType: f.mimetype || null,
          fileSize: f.size ?? null,
          priority,
          policyId,
          sessionId: source === 'customer' ? sessionId : null,
        });
        await addEvent(
          existing.id,
          'uploaded',
          'Reupload — pipeline restart from beginning',
          {
            source,
            fileName: f.originalname,
            force: Boolean(force),
            startOver: true,
            previousStatus: existing.pipeline_status,
            sessionId: sessionId ?? undefined,
            policyId: policyId ?? undefined,
            fileId: file.id,
          }
        );
      } else {
        // New association for this source (may share physical file with other sources).
        doc = await createDocument({
          location,
          source,
          priority,
          fileName: f.originalname,
          fileHash: hash,
          fileId: file.id,
          fileType: f.mimetype || null,
          fileSize: f.size ?? null,
          policyId,
          sessionId: source === 'customer' ? sessionId : null,
        });
        await addEvent(doc.id, 'uploaded', 'Document uploaded and queued', {
          source,
          fileName: f.originalname,
          policyId: policyId ?? undefined,
          sessionId: sessionId ?? undefined,
          fileId: file.id,
          sharedFile: !fileCreated,
        });
      }

      if (!doc) {
        throw new Error('Failed to create/reset document');
      }

      const enqueued = await enqueueDocumentJob(
        { documentId: doc.id, source },
        { force: Boolean(existing && startOver) }
      );

      documents.push({
        id: doc.id,
        location,
        fileId: file.id,
        jobId: enqueued.jobId,
        queue: enqueued.queue,
        source,
        sessionId: doc.session_id ?? (source === 'customer' ? sessionId : null),
        pipelineStatus: 'queued',
        duplicate: false,
        forced: Boolean(existing && startOver),
        sharedFile: !fileCreated,
      });
    }

    return res.status(202).json({
      uploaded: documents.length,
      source,
      sessionId: source === 'customer' ? sessionId : null,
      force,
      documents,
      message:
        source === 'customer'
          ? 'Accepted. Shared file storage; customer association is summaries-only. Same hash+policy completed summary reuses the customer row; other sources get a new association on the same file.'
          : 'Accepted. Shared file storage; poll GET /documents/:id. Same source+hash skips unless force=true or prior failed. Cross-source creates a new document on the shared file.',
    });
  } catch (err: any) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err?.message || 'upload_failed' });
  }
}
