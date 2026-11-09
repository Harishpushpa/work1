import { Router } from 'express';
import {
  createTestRunHandler,
  getTestReportHandler,
  getTestRunHandler,
  listTestRunsHandler,
  testingUploadMiddleware,
} from './testing.controller';

const router = Router();

/**
 * @openapi
 * /api/testing/runs:
 *   post:
 *     summary: Start a RAG testing pipeline run
 *     description: |
 *       Creates a new chat session, uploads the document, waits for ingestion,
 *       then asks each question from the Excel sheet in the same session.
 *       Store `text` with run meta (embedding model, chat model, notes).
 *     tags: [Testing]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [document, text]
 *             properties:
 *               document:
 *                 type: string
 *                 format: binary
 *               questions:
 *                 type: string
 *                 format: binary
 *                 description: Optional .xlsx (defaults to RAG_TEST_QUESTIONS_PATH)
 *               text:
 *                 type: string
 *                 description: Meta for this run (embedding model, LLM, notes)
 *               limit:
 *                 type: integer
 *               force:
 *                 type: boolean
 *     responses:
 *       '202':
 *         description: Run accepted
 *   get:
 *     summary: List recent RAG test runs
 *     tags: [Testing]
 *     responses:
 *       '200':
 *         description: Run list
 */
router.post('/runs', testingUploadMiddleware, createTestRunHandler);
router.get('/runs', listTestRunsHandler);
router.get('/runs/:runId', getTestRunHandler);
router.get('/runs/:runId/report', getTestReportHandler);

export default router;
