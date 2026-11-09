import { RequestContext } from "../context/request-context";
import { logger } from "./logger";

export async function timedAsync<T>(
  fn: () => Promise<T>
): Promise<{ result: T; durationMs: number }> {
  const startedAt = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - startedAt);

  return { result, durationMs };
}

export async function measureAsync<T>(
  operation: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>
): Promise<T> {
  const { result, durationMs } = await timedAsync(fn);

  logger.debug(
    {
      requestId: RequestContext.getRequestId(),
      operation,
      durationMs,
      ...context,
    },
    `${operation} completed`
  );

  return result;
}
