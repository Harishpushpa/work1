export type RagTestRunStatus =
  | 'queued'
  | 'uploading'
  | 'ingesting'
  | 'asking'
  | 'completed'
  | 'failed';

export type RagTestQuestion = {
  testId: string;
  category: string;
  question: string;
  /** Ground-truth / reference answer from the Excel sheet. */
  actualAnswer: string;
};

export type RagTestResultRow = {
  id: string;
  runId: string;
  testId: string;
  category: string;
  question: string;
  actualAnswer: string;
  llmResponse: string;
  status: 'ok' | 'error';
  error: string | null;
  latencyMs: number | null;
  sources: unknown;
  createdAt: Date;
};

export type RagTestRunRow = {
  id: string;
  sessionId: string;
  documentId: string | null;
  status: RagTestRunStatus;
  /** Freeform meta: embedding model, chat model, notes, etc. */
  text: string;
  questionsPath: string | null;
  documentName: string | null;
  questionCount: number;
  completedCount: number;
  error: string | null;
  reportPath: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RagTestReport = {
  runId: string;
  sessionId: string;
  documentId: string | null;
  status: RagTestRunStatus;
  text: string;
  documentName: string | null;
  questionCount: number;
  completedCount: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  results: Array<{
    testId: string;
    category: string;
    question: string;
    actualAnswer: string;
    llmResponse: string;
    status: 'ok' | 'error';
    error: string | null;
    latencyMs: number | null;
    sources: unknown;
  }>;
};
