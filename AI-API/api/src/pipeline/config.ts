function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Like intEnv but allows 0 (used to disable retention for a source). */
function intEnvAllowZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * BullMQ retry delays (ms): 30s → 60s → 90s.
 * Override with DOC_JOB_BACKOFF_MS=30000,60000,90000
 */
function backoffDelaysEnv(): number[] {
  const raw = String(process.env.DOC_JOB_BACKOFF_MS || '').trim();
  if (raw) {
    const parsed = raw
      .split(/[,\s]+/)
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (parsed.length > 0) return parsed;
  }
  return [30_000, 60_000, 90_000];
}

/** Pipeline / worker reliability settings (env-configurable). */
export const pipelineConfig = {
  /**
   * Max failure retries before document stays failed.
   * Default 3 retries after the first attempt (delays 30s / 60s / 90s).
   */
  retryLimit: intEnv('DOCUMENT_RETRY_LIMIT', 3),
  /**
   * BullMQ total attempts = 1 initial + retryLimit delayed retries.
   */
  jobAttempts: intEnv(
    'DOC_JOB_ATTEMPTS',
    intEnv('DOCUMENT_RETRY_LIMIT', 3) + 1
  ),
  /** Delay before retry #1, #2, #3… (ms). */
  backoffDelaysMs: backoffDelaysEnv(),
  /** Worker heartbeat while a job is running. */
  heartbeatIntervalMs: intEnv('HEARTBEAT_INTERVAL_MS', 30_000),
  /** How often to scan for stuck running jobs. */
  reconcileIntervalMs: intEnv('RECONCILE_INTERVAL_MS', 5 * 60_000),
  /**
   * A running job with no heartbeat newer than this is considered stuck
   * and re-queued (if under retry limit).
   * Must be >> HEARTBEAT_INTERVAL (default 10m so long interpret/FAQ is safe).
   */
  stuckThresholdMs: intEnv('STUCK_JOB_THRESHOLD_MS', 10 * 60_000),
  /**
   * Ingestion retention (worker loop).
   * - customer: after N days delete file + Qdrant vectors + FAQs/summaries + pipeline rows
   * - admin: after N days delete uploaded file only (KB FAQs/vectors kept)
   * Set days to 0 to disable that source. RETENTION_ENABLED=false disables all.
   */
  retentionEnabled:
    String(process.env.RETENTION_ENABLED || 'true').toLowerCase() !== 'false',
  retentionCustomerDays: intEnvAllowZero('RETENTION_CUSTOMER_DAYS', 30),
  retentionAdminFileDays: intEnvAllowZero('RETENTION_ADMIN_FILE_DAYS', 90),
  retentionIntervalMs: intEnv('RETENTION_INTERVAL_MS', 24 * 60 * 60_000),
};

/** Delay before the Nth retry (attemptsMade is 1 after first failure). */
export function backoffDelayForAttempt(attemptsMade: number): number {
  const delays = pipelineConfig.backoffDelaysMs;
  if (delays.length === 0) return 30_000;
  const idx = Math.max(0, Math.min(attemptsMade - 1, delays.length - 1));
  return delays[idx];
}
