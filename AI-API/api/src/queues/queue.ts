import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  backoffDelayForAttempt,
  pipelineConfig,
} from '../pipeline/config';
import type { DocumentSource, ProcessDocumentJobData } from '../pipeline/types';

// BullMQ requires maxRetriesPerRequest null for blocking commands.
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});
export const redisConnection = connection;

export const PRIORITY_QUEUE = 'docs.priority';
export const NORMAL_QUEUE = 'docs.normal';
/** @deprecated legacy name — prefer priority/normal */
export const LEGACY_QUEUE = 'jobs';

/**
 * Custom backoff: 30s → 60s → 90s (see pipelineConfig.backoffDelaysMs).
 * Worker must register the same strategy via settings.backoffStrategy.
 */
const defaultJobOpts = {
  removeOnComplete: 200,
  removeOnFail: 200,
  attempts: pipelineConfig.jobAttempts,
  backoff: {
    type: 'custom' as const,
  },
};

/** BullMQ worker `settings.backoffStrategy` — attemptsMade is 1 on first retry. */
export function documentJobBackoffStrategy(attemptsMade: number): number {
  const delay = backoffDelayForAttempt(attemptsMade);
  console.log(
    `[queue] backoff attempt=${attemptsMade} delayMs=${delay} (${Math.round(delay / 1000)}s)`
  );
  return delay;
}

export const priorityQueue = new Queue(PRIORITY_QUEUE, { connection });
export const normalQueue = new Queue(NORMAL_QUEUE, { connection });
/** Kept for backward compatibility with /jobs routes */
export const jobQueue = new Queue(LEGACY_QUEUE, { connection });

export function queueNameForSource(source: DocumentSource): string {
  return source === 'customer' ? PRIORITY_QUEUE : NORMAL_QUEUE;
}

export function priorityValueForSource(source: DocumentSource): number {
  // Lower number = higher priority in BullMQ
  return source === 'customer' ? 1 : 10;
}

function isJobLockedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not be removed because it is locked/i.test(message);
}

export async function getDocumentJobState(
  documentId: string,
  source: DocumentSource
): Promise<{ jobId: string; state: string } | null> {
  const queue = source === 'customer' ? priorityQueue : normalQueue;
  const jobId = `doc-${documentId}`;
  const existing = await queue.getJob(jobId);
  if (!existing) return null;
  const state = await existing.getState();
  return { jobId, state };
}

export async function enqueueDocumentJob(
  data: ProcessDocumentJobData,
  opts: { force?: boolean; delayMs?: number } = {}
) {
  const queue =
    data.source === 'customer' ? priorityQueue : normalQueue;
  let jobId = `doc-${data.documentId}`;

  if (opts.force) {
    const existing = await queue.getJob(jobId);
    if (existing) {
      try {
        await existing.remove();
      } catch (err) {
        if (!isJobLockedError(err)) throw err;
        // Active lock held by a worker — use a distinct id so we don't block
        // re-queue. Prefer skipping via getDocumentJobState in reconcile.
        jobId = `doc-${data.documentId}-r${Date.now()}`;
        console.warn(
          `[queue] job doc-${data.documentId} is locked; enqueueing as ${jobId}`
        );
      }
    }
  }

  const job = await queue.add('process-document', data, {
    ...defaultJobOpts,
    jobId,
    priority: priorityValueForSource(data.source),
    ...(opts.delayMs && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
  });

  return {
    jobId: job.id,
    queue: queueNameForSource(data.source),
    delayMs: opts.delayMs ?? 0,
  };
}
