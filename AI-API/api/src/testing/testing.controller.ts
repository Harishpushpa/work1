import { Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { ResponseBuilder } from '../platform/response/response-builder';
import {
  getRagTestReport,
  getRagTestRun,
  listRagTestRuns,
  startRagTestRun,
} from './testing.service';

const UPLOAD_ROOT =
  process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dest = path.join(UPLOAD_ROOT, 'rag-tests');
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

export const testingUploadMiddleware = multer({ storage }).fields([
  { name: 'document', maxCount: 1 },
  { name: 'files', maxCount: 1 },
  { name: 'questions', maxCount: 1 },
]);

function firstFile(
  files: { [fieldname: string]: Express.Multer.File[] } | undefined,
  ...names: string[]
): Express.Multer.File | undefined {
  if (!files) return undefined;
  for (const name of names) {
    const arr = files[name];
    if (arr?.[0]) return arr[0];
  }
  return undefined;
}

/**
 * POST /api/testing/runs
 * multipart: document (or files), optional questions xlsx, text (meta), limit, force
 */
export async function createTestRunHandler(req: Request, res: Response) {
  try {
    const files = req.files as
      | { [fieldname: string]: Express.Multer.File[] }
      | undefined;
    const documentFile = firstFile(files, 'document', 'files');
    if (!documentFile) {
      return res.status(400).json({
        error: 'document file is required (field "document" or "files")',
      });
    }

    const text = String(req.body?.text ?? '').trim();
    const limitRaw = Number(req.body?.limit ?? req.query?.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : undefined;
    const forceRaw = String(req.body?.force ?? req.query?.force ?? 'false');
    const force = ['1', 'true', 'yes'].includes(forceRaw.toLowerCase());

    const questionsFile = firstFile(files, 'questions');

    const run = await startRagTestRun({
      text,
      documentFile,
      questionsFile,
      limit,
      force,
    });

    return ResponseBuilder.accepted(
      res,
      {
        runId: run.id,
        sessionId: run.sessionId,
        status: run.status,
        text: run.text,
        documentName: run.documentName,
        questionCount: run.questionCount,
        message:
          'Test run accepted. Poll GET /api/testing/runs/:runId until status=completed, then GET /api/testing/runs/:runId/report',
      },
      'RAG test run queued'
    );
  } catch (err: any) {
    const status = err?.status || 500;
    console.error('createTestRunHandler error:', err);
    return res.status(status).json({
      error: err?.message || 'test_run_create_failed',
    });
  }
}

export async function getTestRunHandler(req: Request, res: Response) {
  try {
    const runId = String(req.params.runId || '');
    const run = await getRagTestRun(runId);
    if (!run) {
      return res.status(404).json({ error: 'run_not_found' });
    }
    return ResponseBuilder.success(res, {
      runId: run.id,
      sessionId: run.sessionId,
      documentId: run.documentId,
      status: run.status,
      text: run.text,
      documentName: run.documentName,
      questionCount: run.questionCount,
      completedCount: run.completedCount,
      error: run.error,
      reportPath: run.reportPath,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
    });
  } catch (err: any) {
    console.error('getTestRunHandler error:', err);
    return res.status(500).json({ error: err?.message || 'get_run_failed' });
  }
}

export async function listTestRunsHandler(req: Request, res: Response) {
  try {
    const limitRaw = Number(req.query.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50;
    const runs = await listRagTestRuns(limit);
    return ResponseBuilder.success(res, { runs });
  } catch (err: any) {
    console.error('listTestRunsHandler error:', err);
    return res.status(500).json({ error: err?.message || 'list_runs_failed' });
  }
}

export async function getTestReportHandler(req: Request, res: Response) {
  try {
    const runId = String(req.params.runId || '');
    const report = await getRagTestReport(runId);
    if (!report) {
      return res.status(404).json({ error: 'run_not_found' });
    }
    return ResponseBuilder.success(res, report);
  } catch (err: any) {
    console.error('getTestReportHandler error:', err);
    return res
      .status(500)
      .json({ error: err?.message || 'get_report_failed' });
  }
}
