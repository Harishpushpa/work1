/**
 * Remove BullMQ jobs that still use pre-UUID numeric document ids
 * (e.g. doc-3 / documentId: 3) after the documents.id → UUID migration.
 *
 * Usage: npx ts-node --transpile-only src/queues/purge-legacy-jobs.ts
 */
import 'dotenv/config';
import { Queue } from 'bullmq';
import {
  connection,
  LEGACY_QUEUE,
  NORMAL_QUEUE,
  PRIORITY_QUEUE,
} from './queue';
import { isDocumentUuid } from '../pipeline/types';

const STATES = [
  'waiting',
  'delayed',
  'prioritized',
  'active',
  'paused',
  'wait',
  'completed',
  'failed',
] as const;

function isLegacyDocumentJob(job: {
  id?: string | null;
  data?: { documentId?: unknown };
}): boolean {
  const documentId = job.data?.documentId;
  if (documentId == null) return false;
  if (!isDocumentUuid(documentId)) return true;
  const id = String(job.id ?? '');
  // doc-3, doc-12-r123 — numeric document segment
  const m = /^doc-(\d+)(?:-|$)/.exec(id);
  return Boolean(m);
}

async function purgeQueue(name: string): Promise<number> {
  const queue = new Queue(name, { connection });
  let removed = 0;

  for (const state of STATES) {
    let start = 0;
    const page = 100;
    // getJobs window is inclusive; walk until empty
    for (;;) {
      const jobs = await queue.getJobs([state as any], start, start + page - 1);
      if (!jobs.length) break;

      for (const job of jobs) {
        if (!isLegacyDocumentJob(job)) continue;
        try {
          await job.remove();
          removed += 1;
          console.log(
            `[purge] ${name} removed ${job.id} state=${state} documentId=${job.data?.documentId}`
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/locked/i.test(message)) {
            try {
              await job.moveToFailed(
                new Error('Purged legacy non-UUID document job'),
                '0',
                true
              );
              removed += 1;
              console.warn(
                `[purge] ${name} moved locked ${job.id} to failed`
              );
            } catch (err2) {
              console.warn(
                `[purge] ${name} could not remove locked ${job.id}:`,
                err2 instanceof Error ? err2.message : err2
              );
            }
          } else {
            console.warn(`[purge] ${name} skip ${job.id}:`, message);
          }
        }
      }

      if (jobs.length < page) break;
      start += page;
    }
  }

  await queue.close();
  return removed;
}

async function main() {
  const queues = [PRIORITY_QUEUE, NORMAL_QUEUE, LEGACY_QUEUE];
  let total = 0;
  for (const name of queues) {
    const n = await purgeQueue(name);
    console.log(`[purge] ${name}: ${n} legacy job(s) removed`);
    total += n;
  }
  console.log(`[purge] done; total=${total}`);
  await connection.quit();
}

main().catch(async (err) => {
  console.error('[purge] failed', err);
  try {
    await connection.quit();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
