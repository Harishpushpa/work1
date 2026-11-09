import {
  backoffDelayForAttempt,
  pipelineConfig,
} from '../pipeline/config';
import {
  addEvent,
  findStuckDocuments,
  requeueStuckDocument,
} from '../pipeline/repository';
import { enqueueDocumentJob, getDocumentJobState } from './queue';

/**
 * Every RECONCILE_INTERVAL_MS, find running docs with stale heartbeats
 * and re-queue them (respecting DOCUMENT_RETRY_LIMIT).
 */
export async function reconcileStuckJobs(): Promise<number> {
  const stuck = await findStuckDocuments(pipelineConfig.stuckThresholdMs);
  let requeued = 0;

  for (const doc of stuck) {
    try {
      // Never force-remove an active BullMQ job — remove() throws while locked.
      // Wait for lockDuration / stall recovery instead of racing the worker.
      const bull = await getDocumentJobState(doc.id, doc.source);
      if (bull?.state === 'active') {
        console.warn(
          `[reconcile] skip doc ${doc.id}: job ${bull.jobId} still active/locked ` +
            `(step=${doc.pipeline_step}); waiting for stall or heartbeat`
        );
        continue;
      }

      const reason = `Stuck job reconciled (no heartbeat for ${pipelineConfig.stuckThresholdMs}ms) at step=${doc.pipeline_step}`;
      const updated = await requeueStuckDocument(doc.id, reason);
      if (!updated) continue;

      await addEvent(doc.id, doc.pipeline_step || 'running', reason, {
        retryCount: updated.retry_count,
        retryLimit: updated.retry_limit,
      });

      if (updated.pipeline_status === 'queued') {
        // Same stepped backoff as BullMQ: 30s → 60s → 90s by retry_count.
        const delayMs = backoffDelayForAttempt(updated.retry_count);
        await enqueueDocumentJob(
          { documentId: updated.id, source: updated.source },
          { force: true, delayMs }
        );
        requeued += 1;
        console.log(
          `[reconcile] re-queued doc ${updated.id} ` +
            `(retry ${updated.retry_count}/${updated.retry_limit}, delay=${delayMs}ms); ` +
            `will resume from step=${updated.pipeline_step}`
        );
      } else {
        console.log(
          `[reconcile] doc ${updated.id} marked failed (retries exhausted)`
        );
      }
    } catch (err) {
      console.error(
        `[reconcile] failed for doc ${doc.id}`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return requeued;
}

export function startReconcileLoop(): NodeJS.Timeout {
  console.log(
    `[reconcile] every ${pipelineConfig.reconcileIntervalMs}ms; ` +
      `stuck if no heartbeat > ${pipelineConfig.stuckThresholdMs}ms; ` +
      `retryLimit=${pipelineConfig.retryLimit}`
  );

  // Run once shortly after boot, then on interval
  setTimeout(() => {
    reconcileStuckJobs().catch((err) =>
      console.error('[reconcile] boot pass failed', err)
    );
  }, 15_000);

  return setInterval(() => {
    reconcileStuckJobs().catch((err) =>
      console.error('[reconcile] pass failed', err)
    );
  }, pipelineConfig.reconcileIntervalMs);
}
