import type { RetryPolicy } from "../context.js";

export const DEFAULT_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_BACKOFF_FACTOR = 2;
export const DEFAULT_MAX_DELAY_MS = 5 * 60_000;

export function computeRetryDelayMs(policy: RetryPolicy, attempt: number): number {
  const initial = policy.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const factor = policy.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const max = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  return Math.min(initial * factor ** (attempt - 1), max);
}
