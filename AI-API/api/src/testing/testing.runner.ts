import fs from 'fs';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import {
  addEvent,
  countFaqs,
  countSummaries,
  createDocument,
  findDocRefByDocumentId,
  findLatestDocumentBySessionId,
  getDocument,
} from '../pipeline/repository';
import { sourceNeedsFaqs, sourceNeedsSummaries } from '../pipeline/types';
import {
  enqueueDocumentJob,
  priorityValueForSource,
} from '../queues/queue';
import { ConversationService } from '../conversation/conversation.service';
import { LlmMemoryService } from '../llm/memory/llm-memory.service';
import { parseQuestionsWorkbook } from './questions-excel';
import {
  buildTestReport,
  insertTestResult,
  updateTestRun,
} from './testing.repository';
import type { RagTestQuestion } from './testing.types';

const HAYSTACK_CHAT_URL =
  process.env.HAYSTACK_CHAT_URL || 'http://localhost:8000/chat';

const POLL_MS = Number(process.env.RAG_TEST_POLL_MS || 5000);
const INGEST_TIMEOUT_MS = Number(
  process.env.RAG_TEST_INGEST_TIMEOUT_MS || 60 * 60 * 1000
);
const REPORTS_DIR =
  process.env.RAG_TEST_REPORTS_DIR ||
  path.join(process.cwd(), 'reports', 'rag-tests');

const conversationService = new ConversationService();
const llmMemoryService = new LlmMemoryService();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForChatReady(documentId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < INGEST_TIMEOUT_MS) {
    const doc = await getDocument(documentId);
    if (!doc) {
      throw new Error(`Document ${documentId} not found while waiting`);
    }
    if (doc.pipeline_status === 'failed') {
      throw new Error(
        `Ingestion failed: ${doc.error || 'pipeline_status=failed'}`
      );
    }

    const [faqCount, summaryCount] = await Promise.all([
      countFaqs(doc.id),
      countSummaries(doc.id),
    ]);
    const enrichmentOk =
      (!sourceNeedsFaqs(doc.source) || faqCount > 0) &&
      (!sourceNeedsSummaries(doc.source) || summaryCount > 0);
    const ready =
      doc.pipeline_status === 'completed' &&
      doc.chat_ready &&
      enrichmentOk;

    if (ready) return;

    await sleep(POLL_MS);
  }
  throw new Error(
    `Timed out waiting for document ${documentId} to become chat-ready (${INGEST_TIMEOUT_MS}ms)`
  );
}

async function askOne(
  sessionId: string,
  question: string
): Promise<{ answer: string; sources: unknown; latencyMs: number }> {
  const t0 = Date.now();

  await conversationService.saveMessage({
    conversationId: sessionId,
    role: 'user' as any,
    content: question,
    provider: 'rag-test',
    model: 'harness',
  });

  const history = await llmMemoryService.getHistory(sessionId);
  history.push({ role: 'user', content: question });

  const summary = await llmMemoryService.getSummary(sessionId);
  if (summary) {
    history.push({
      role: 'system',
      content: `Conversation Summary: ${summary}`,
    });
  }

  const payload: Record<string, unknown> = {
    message: question,
    conversationId: sessionId,
    recent_messages: history,
    summary,
  };

  const document = await findLatestDocumentBySessionId(sessionId);
  if (document) {
    const docRef = await findDocRefByDocumentId(document.id);
    if (docRef) {
      payload.policy_number =
        docRef.policy_number || document.policy_id || null;
      payload.policy_name = docRef.policy_name;
      payload.company_name = docRef.company_name;
      payload.insurer_name = docRef.insurer_name;
      payload.categories = docRef.categories;
    } else if (document.policy_id) {
      payload.policy_number = document.policy_id;
    }
  }

  const resp = await axios.post(HAYSTACK_CHAT_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 1_200_000,
  });

  const EMPTY_FALLBACK =
    "I don’t have enough information to provide an accurate answer.";
  let answer = String(resp?.data?.answer ?? '').trim();
  if (!answer) answer = EMPTY_FALLBACK;

  await conversationService.saveMessage({
    conversationId: sessionId,
    role: 'assistant' as any,
    content: answer,
    provider: 'haystack',
    model: resp?.data?.model ?? 'haystack',
  });

  return {
    answer,
    sources: resp?.data?.sources ?? null,
    latencyMs: Date.now() - t0,
  };
}

async function writeReportFile(
  runId: string
): Promise<{ reportPath: string }> {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const report = await buildTestReport(runId);
  if (!report) {
    throw new Error(`Cannot write report — run ${runId} missing`);
  }
  const reportPath = path.join(REPORTS_DIR, `${runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return { reportPath };
}

export type StartTestRunInput = {
  runId: string;
  sessionId: string;
  documentFile: {
    path: string;
    originalname: string;
    mimetype?: string;
    size?: number;
  };
  questionsPath: string;
  questions?: RagTestQuestion[];
  force?: boolean;
  limit?: number;
};

/**
 * Background orchestration: upload → wait ingestion → ask each question → store report.
 */
export async function executeTestRun(input: StartTestRunInput): Promise<void> {
  const { runId, sessionId, documentFile, questionsPath } = input;

  try {
    await updateTestRun(runId, {
      status: 'uploading',
      startedAt: new Date(),
      documentName: documentFile.originalname,
    });

    const questions =
      input.questions ??
      parseQuestionsWorkbook(questionsPath, { limit: input.limit });

    await updateTestRun(runId, { questionCount: questions.length });

    const relPath = path.relative(process.cwd(), documentFile.path);
    const source = 'customer' as const;
    const priority = priorityValueForSource(source);

    const buf = fs.readFileSync(documentFile.path);
    const fileHash = crypto.createHash('sha256').update(buf).digest('hex');

    const doc = await createDocument({
      location: relPath,
      source,
      priority,
      fileName: documentFile.originalname,
      fileHash,
      fileType: documentFile.mimetype || null,
      fileSize: documentFile.size ?? buf.length,
      sessionId,
    });

    await addEvent(doc.id, 'uploaded', 'RAG test run uploaded document', {
      runId,
      sessionId,
      fileName: documentFile.originalname,
    });

    await enqueueDocumentJob(
      { documentId: doc.id, source },
      { force: Boolean(input.force) }
    );

    await updateTestRun(runId, {
      status: 'ingesting',
      documentId: doc.id,
    });

    await waitForChatReady(doc.id);

    await updateTestRun(runId, { status: 'asking' });

    let completed = 0;
    for (const q of questions) {
      try {
        const { answer, sources, latencyMs } = await askOne(
          sessionId,
          q.question
        );
        await insertTestResult({
          runId,
          testId: q.testId,
          category: q.category,
          question: q.question,
          actualAnswer: q.actualAnswer,
          llmResponse: answer,
          status: 'ok',
          latencyMs,
          sources,
        });
      } catch (err: any) {
        await insertTestResult({
          runId,
          testId: q.testId,
          category: q.category,
          question: q.question,
          actualAnswer: q.actualAnswer,
          llmResponse: '',
          status: 'error',
          error: err?.message || 'ask_failed',
        });
      }
      completed += 1;
      await updateTestRun(runId, { completedCount: completed });
    }

    const { reportPath } = await writeReportFile(runId);
    await updateTestRun(runId, {
      status: 'completed',
      reportPath,
      finishedAt: new Date(),
      error: null,
    });
  } catch (err: any) {
    console.error(`[rag-test] run ${runId} failed:`, err);
    try {
      const { reportPath } = await writeReportFile(runId);
      await updateTestRun(runId, {
        status: 'failed',
        error: err?.message || 'test_run_failed',
        reportPath,
        finishedAt: new Date(),
      });
    } catch {
      await updateTestRun(runId, {
        status: 'failed',
        error: err?.message || 'test_run_failed',
        finishedAt: new Date(),
      });
    }
  }
}
