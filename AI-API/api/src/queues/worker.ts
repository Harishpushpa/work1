import { loadApiEnv } from '../platform/database/postgres-env';

// api/.env wins over ambient PM2/shell env (passwords with @).
loadApiEnv();

import { UnrecoverableError, Worker } from 'bullmq';
import { pipelineConfig } from '../pipeline/config';
import { runDocumentPipeline } from '../pipeline/runner';
import { timeouts } from '../pipeline/timeouts';
import {
  isDocumentUuid,
  type ProcessDocumentJobData,
} from '../pipeline/types';
import {
  NORMAL_QUEUE,
  PRIORITY_QUEUE,
  connection,
  documentJobBackoffStrategy,
} from './queue';
import { startRetentionLoop } from '../pipeline/retention';
import { startReconcileLoop } from './reconcile';

async function processJob(job: {
  id?: string;
  name: string;
  data: ProcessDocumentJobData;
  attemptsMade?: number;
  updateProgress: (p: unknown) => Promise<void>;
}) {
  const attempt = (job.attemptsMade ?? 0) + 1;
  console.log(
    `Processing job ${job.id} name=${job.name} documentId=${job.data?.documentId} ` +
      `attempt=${attempt}/${pipelineConfig.jobAttempts} (resume from checkpoints)`
  );

  if (!job.data?.documentId) {
    throw new UnrecoverableError('Job missing documentId');
  }

  // Pre-UUID migration jobs (documentId: 3) must not hit Postgres or retry forever.
  if (!isDocumentUuid(job.data.documentId)) {
    throw new UnrecoverableError(
      `Legacy non-UUID documentId=${job.data.documentId}; purged after id migration. Re-upload the document.`
    );
  }

  const result = await runDocumentPipeline(job.data, async (progress) => {
    await job.updateProgress(progress);
  });

  return {
    ok: true,
    ...result,
    processedAt: new Date().toISOString(),
  };
}

const workerOpts = {
  connection,
  concurrency: Number(process.env.DOC_WORKER_CONCURRENCY || 2),
  lockDuration: timeouts.jobLock,
  stalledInterval: Math.min(timeouts.jobLock, 60_000),
  // Custom retry delays: 30s → 60s → 90s (must match job backoff type=custom).
  settings: {
    backoffStrategy: (attemptsMade: number) =>
      documentJobBackoffStrategy(attemptsMade),
  },
};

const priorityConcurrency = Number(
  process.env.DOC_PRIORITY_CONCURRENCY ||
    process.env.DOC_WORKER_CONCURRENCY ||
    3
);
const normalConcurrency = Number(process.env.DOC_NORMAL_CONCURRENCY || 1);

export const priorityWorker = new Worker(
  PRIORITY_QUEUE,
  async (job) => processJob(job as any),
  { ...workerOpts, concurrency: priorityConcurrency }
);

export const normalWorker = new Worker(
  NORMAL_QUEUE,
  async (job) => processJob(job as any),
  { ...workerOpts, concurrency: normalConcurrency }
);

function attachLogs(worker: Worker, label: string) {
  worker.on('completed', (job) => {
    console.log(`[${label}] Job ${job.id} completed`);
  });
  worker.on('failed', (job, err) => {
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts?.attempts ?? pipelineConfig.jobAttempts;
    console.error(
      `[${label}] Job ${job ? job.id : '<unknown>'} failed ` +
        `(attempt ${attempts}/${max}):`,
      err?.message || err
    );
  });
}

attachLogs(priorityWorker, PRIORITY_QUEUE);
attachLogs(normalWorker, NORMAL_QUEUE);

startReconcileLoop();
startRetentionLoop();

console.log(
  `Workers listening: ${PRIORITY_QUEUE} (concurrency=${priorityConcurrency}), ` +
    `${NORMAL_QUEUE} (concurrency=${normalConcurrency}), ` +
    `lockDuration=${timeouts.jobLock}ms, heartbeat=${pipelineConfig.heartbeatIntervalMs}ms`
);

export default priorityWorker;
