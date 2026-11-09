function ms(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const timeouts = {
  extract: ms('EXTRACT_TIMEOUT_MS', 15 * 60 * 1000),
  interpret: ms('INTERPRET_TIMEOUT_MS', 10 * 60 * 1000),
  ingest: ms('INGEST_TIMEOUT_MS', 15 * 60 * 1000),
  faq: ms('FAQ_TIMEOUT_MS', 30 * 60 * 1000),
  summary: ms('SUMMARY_TIMEOUT_MS', 30 * 60 * 1000),
  /** BullMQ lock must exceed the slowest single step. */
  jobLock: ms('JOB_LOCK_DURATION_MS', 45 * 60 * 1000),
};
