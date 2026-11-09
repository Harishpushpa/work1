import pool from '../db';
import type {
  RagTestReport,
  RagTestResultRow,
  RagTestRunRow,
  RagTestRunStatus,
} from './testing.types';

function mapRun(row: any): RagTestRunRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    documentId: row.document_id ? String(row.document_id) : null,
    status: row.status as RagTestRunStatus,
    text: String(row.text ?? ''),
    questionsPath: row.questions_path ?? null,
    documentName: row.document_name ?? null,
    questionCount: Number(row.question_count ?? 0),
    completedCount: Number(row.completed_count ?? 0),
    error: row.error ?? null,
    reportPath: row.report_path ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResult(row: any): RagTestResultRow {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    testId: String(row.test_id),
    category: String(row.category ?? ''),
    question: String(row.question ?? ''),
    actualAnswer: String(row.actual_answer ?? ''),
    llmResponse: String(row.llm_response ?? ''),
    status: row.status === 'error' ? 'error' : 'ok',
    error: row.error ?? null,
    latencyMs: row.latency_ms != null ? Number(row.latency_ms) : null,
    sources: row.sources ?? null,
    createdAt: row.created_at,
  };
}

/** Insert an active chat_sessions row for the test harness. */
export async function createTestChatSession(input?: {
  userId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const userId = input?.userId || 'rag-test';
  const metadata = {
    type: 'rag_test',
    ...(input?.metadata || {}),
  };
  const res = await pool.query(
    `INSERT INTO chat_sessions (user_id, active, metadata)
     VALUES ($1, true, $2::jsonb)
     RETURNING id::text AS id`,
    [userId, JSON.stringify(metadata)]
  );
  return { id: res.rows[0].id };
}

export async function createTestRun(input: {
  sessionId: string;
  text: string;
  questionsPath?: string | null;
  documentName?: string | null;
  questionCount?: number;
}): Promise<RagTestRunRow> {
  const res = await pool.query(
    `INSERT INTO rag_test_runs (
       session_id, status, text, questions_path, document_name, question_count
     ) VALUES ($1, 'queued', $2, $3, $4, $5)
     RETURNING *`,
    [
      input.sessionId,
      input.text,
      input.questionsPath ?? null,
      input.documentName ?? null,
      input.questionCount ?? 0,
    ]
  );
  return mapRun(res.rows[0]);
}

export async function updateTestRun(
  runId: string,
  patch: Partial<{
    status: RagTestRunStatus;
    documentId: string | null;
    questionCount: number;
    completedCount: number;
    error: string | null;
    reportPath: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    documentName: string | null;
  }>
): Promise<RagTestRunRow | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, value: unknown) => {
    vals.push(value);
    sets.push(`${col} = $${vals.length}`);
  };

  if (patch.status !== undefined) push('status', patch.status);
  if (patch.documentId !== undefined) push('document_id', patch.documentId);
  if (patch.questionCount !== undefined) {
    push('question_count', patch.questionCount);
  }
  if (patch.completedCount !== undefined) {
    push('completed_count', patch.completedCount);
  }
  if (patch.error !== undefined) push('error', patch.error);
  if (patch.reportPath !== undefined) push('report_path', patch.reportPath);
  if (patch.startedAt !== undefined) push('started_at', patch.startedAt);
  if (patch.finishedAt !== undefined) push('finished_at', patch.finishedAt);
  if (patch.documentName !== undefined) {
    push('document_name', patch.documentName);
  }

  if (sets.length === 0) {
    return getTestRun(runId);
  }

  vals.push(runId);
  const res = await pool.query(
    `UPDATE rag_test_runs
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${vals.length}
     RETURNING *`,
    vals
  );
  return res.rows[0] ? mapRun(res.rows[0]) : null;
}

export async function getTestRun(runId: string): Promise<RagTestRunRow | null> {
  const res = await pool.query(`SELECT * FROM rag_test_runs WHERE id = $1`, [
    runId,
  ]);
  return res.rows[0] ? mapRun(res.rows[0]) : null;
}

export async function listTestRuns(limit = 50): Promise<RagTestRunRow[]> {
  const res = await pool.query(
    `SELECT * FROM rag_test_runs
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)]
  );
  return res.rows.map(mapRun);
}

export async function insertTestResult(input: {
  runId: string;
  testId: string;
  category: string;
  question: string;
  actualAnswer: string;
  llmResponse: string;
  status: 'ok' | 'error';
  error?: string | null;
  latencyMs?: number | null;
  sources?: unknown;
}): Promise<RagTestResultRow> {
  const res = await pool.query(
    `INSERT INTO rag_test_results (
       run_id, test_id, category, question, actual_answer, llm_response,
       status, error, latency_ms, sources
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     RETURNING *`,
    [
      input.runId,
      input.testId,
      input.category,
      input.question,
      input.actualAnswer,
      input.llmResponse,
      input.status,
      input.error ?? null,
      input.latencyMs ?? null,
      JSON.stringify(input.sources ?? null),
    ]
  );
  return mapResult(res.rows[0]);
}

export async function listTestResults(
  runId: string
): Promise<RagTestResultRow[]> {
  const res = await pool.query(
    `SELECT * FROM rag_test_results
     WHERE run_id = $1
     ORDER BY created_at ASC`,
    [runId]
  );
  return res.rows.map(mapResult);
}

export async function buildTestReport(
  runId: string
): Promise<RagTestReport | null> {
  const run = await getTestRun(runId);
  if (!run) return null;
  const results = await listTestResults(runId);
  return {
    runId: run.id,
    sessionId: run.sessionId,
    documentId: run.documentId,
    status: run.status,
    text: run.text,
    documentName: run.documentName,
    questionCount: run.questionCount,
    completedCount: run.completedCount,
    error: run.error,
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    results: results.map((r) => ({
      testId: r.testId,
      category: r.category,
      question: r.question,
      actualAnswer: r.actualAnswer,
      llmResponse: r.llmResponse,
      status: r.status,
      error: r.error,
      latencyMs: r.latencyMs,
      sources: r.sources,
    })),
  };
}
