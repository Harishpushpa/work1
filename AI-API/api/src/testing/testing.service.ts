import fs from 'fs';
import path from 'path';
import { parseQuestionsWorkbook } from './questions-excel';
import {
  buildTestReport,
  createTestChatSession,
  createTestRun,
  getTestRun,
  listTestRuns,
} from './testing.repository';
import { executeTestRun } from './testing.runner';
import type { RagTestReport, RagTestRunRow } from './testing.types';

const DEFAULT_QUESTIONS_PATH =
  process.env.RAG_TEST_QUESTIONS_PATH ||
  'D:\\Downloads\\RAG Questions - Insursa Motor 1.xlsx';

export function resolveDefaultQuestionsPath(): string {
  return DEFAULT_QUESTIONS_PATH;
}

export async function startRagTestRun(input: {
  text: string;
  documentFile: Express.Multer.File;
  questionsFile?: Express.Multer.File | null;
  limit?: number;
  force?: boolean;
}): Promise<RagTestRunRow> {
  const text = String(input.text || '').trim();
  if (!text) {
    throw Object.assign(new Error('text is required (meta: embedding, model, notes)'), {
      status: 400,
    });
  }

  let questionsPath = resolveDefaultQuestionsPath();
  if (input.questionsFile?.path) {
    questionsPath = input.questionsFile.path;
  }

  if (!fs.existsSync(questionsPath)) {
    throw Object.assign(
      new Error(
        `Questions file not found: ${questionsPath}. Upload field "questions" or set RAG_TEST_QUESTIONS_PATH.`
      ),
      { status: 400 }
    );
  }

  // Validate workbook early so the client gets a fast 400.
  const questions = parseQuestionsWorkbook(questionsPath, {
    limit: input.limit,
  });

  const session = await createTestChatSession({
    userId: 'rag-test',
    metadata: {
      type: 'rag_test',
      text,
      documentName: input.documentFile.originalname,
    },
  });

  const run = await createTestRun({
    sessionId: session.id,
    text,
    questionsPath,
    documentName: input.documentFile.originalname,
    questionCount: questions.length,
  });

  // Fire-and-forget background orchestration
  void executeTestRun({
    runId: run.id,
    sessionId: session.id,
    documentFile: {
      path: input.documentFile.path,
      originalname: input.documentFile.originalname,
      mimetype: input.documentFile.mimetype,
      size: input.documentFile.size,
    },
    questionsPath,
    questions,
    force: input.force,
    limit: input.limit,
  });

  return run;
}

export async function getRagTestRun(runId: string): Promise<RagTestRunRow | null> {
  return getTestRun(runId);
}

export async function listRagTestRuns(limit?: number): Promise<RagTestRunRow[]> {
  return listTestRuns(limit);
}

export async function getRagTestReport(
  runId: string
): Promise<RagTestReport | null> {
  return buildTestReport(runId);
}

export function reportsDir(): string {
  return (
    process.env.RAG_TEST_REPORTS_DIR ||
    path.join(process.cwd(), 'reports', 'rag-tests')
  );
}
