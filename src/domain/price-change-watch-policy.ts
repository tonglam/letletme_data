export const PRICE_CHANGE_WATCH_LEAD_MS = 5 * 60_000;
export const PRICE_CHANGE_WATCH_WARM_WINDOW_MS = 2 * 60_000;
export const PRICE_CHANGE_WATCH_NEAR_WINDOW_MS = 10_000;
export const PRICE_CHANGE_WATCH_PREWARM_POLL_MS = 5_000;
export const PRICE_CHANGE_WATCH_WARM_POLL_MS = 1_000;
export const PRICE_CHANGE_WATCH_NEAR_POLL_MS = 500;
export const PRICE_CHANGE_WATCH_POST_DEADLINE_POLL_MS = 250;
export const PRICE_CHANGE_WATCH_FAST_WINDOW_MS = 90_000;
export const PRICE_CHANGE_WATCH_SLOW_POLL_MS = 5_000;
export const PRICE_CHANGE_WATCH_MAX_WINDOW_MS = 5 * 60_000;
export const PRICE_CHANGE_WATCH_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

/**
 * Resolve the target start-to-start cadence for one official deadline watch.
 *
 * The watcher prewarms at a conservative rate, reaches the near-deadline
 * boundary exactly, and then probes aggressively once a price move can become
 * authoritative. Slow upstream requests never add another full interval: the
 * worker subtracts request time before sleeping.
 */
export function resolvePriceChangeWatchPollInterval(nowMs: number, deadlineMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) {
    throw new Error('Price-change watch cadence requires finite timestamps');
  }
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs > PRICE_CHANGE_WATCH_WARM_WINDOW_MS) {
    return Math.min(
      PRICE_CHANGE_WATCH_PREWARM_POLL_MS,
      remainingMs - PRICE_CHANGE_WATCH_WARM_WINDOW_MS,
    );
  }
  if (remainingMs > PRICE_CHANGE_WATCH_NEAR_WINDOW_MS) {
    return Math.min(
      PRICE_CHANGE_WATCH_WARM_POLL_MS,
      remainingMs - PRICE_CHANGE_WATCH_NEAR_WINDOW_MS,
    );
  }
  if (remainingMs > 0) return PRICE_CHANGE_WATCH_NEAR_POLL_MS;
  if (-remainingMs <= PRICE_CHANGE_WATCH_FAST_WINDOW_MS) {
    return PRICE_CHANGE_WATCH_POST_DEADLINE_POLL_MS;
  }
  return PRICE_CHANGE_WATCH_SLOW_POLL_MS;
}

export function resolvePriceChangeWatchSleepDelay(input: {
  readonly probeStartedAtMs: number;
  readonly probeCompletedAtMs: number;
  readonly deadlineMs: number;
  readonly stopAtMs: number;
  readonly retryDelayMs: number;
}): number | null {
  if (
    !Number.isFinite(input.probeStartedAtMs) ||
    !Number.isFinite(input.probeCompletedAtMs) ||
    !Number.isFinite(input.stopAtMs) ||
    !Number.isFinite(input.retryDelayMs) ||
    input.probeCompletedAtMs < input.probeStartedAtMs ||
    input.retryDelayMs < 0
  ) {
    throw new Error('Price-change watch sleep requires a valid probe window');
  }
  const remainingMs = input.stopAtMs - input.probeCompletedAtMs;
  if (remainingMs <= 0) return null;
  const intervalMs = resolvePriceChangeWatchPollInterval(
    input.probeCompletedAtMs,
    input.deadlineMs,
  );
  const cadenceDelayMs = Math.max(
    0,
    intervalMs - (input.probeCompletedAtMs - input.probeStartedAtMs),
  );
  return Math.min(Math.max(cadenceDelayMs, input.retryDelayMs), remainingMs);
}
