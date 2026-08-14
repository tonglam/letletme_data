import { logDebug } from './logger';

export type FplRequestPriority = 'live' | 'bulk';

const MAX_INFLIGHT = Math.max(1, Number(process.env.FPL_MAX_INFLIGHT ?? 5));
const LIVE_RESERVED = Math.min(2, MAX_INFLIGHT);
const BULK_MAX_INFLIGHT = Math.max(1, Math.min(MAX_INFLIGHT - LIVE_RESERVED, 3));
const MIN_INTERVAL_MS = Math.ceil(
  1_000 / Math.max(1, Number(process.env.FPL_REQUESTS_PER_SECOND ?? 4)),
);
const RATE_BURST_SIZE = Math.max(1, Math.floor(Number(process.env.FPL_REQUESTS_PER_SECOND ?? 4)));

type Waiter = {
  priority: FplRequestPriority;
  resolve: () => void;
};

let inflight = 0;
let liveInflight = 0;
let bulkInflight = 0;
let lastStartedAt = 0;
let burstRemaining = RATE_BURST_SIZE;
const waiters: Waiter[] = [];
let rateGate: Promise<void> = Promise.resolve();
let adaptiveBulkLimit = BULK_MAX_INFLIGHT;
let lastBulkErrorAt = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForRateSlot(): Promise<void> {
  let release!: () => void;
  const previous = rateGate;
  rateGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (burstRemaining > 0) {
      burstRemaining -= 1;
      lastStartedAt = Date.now();
      return;
    }
    const spacing = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastStartedAt));
    if (spacing > 0) await sleep(spacing);
    lastStartedAt = Date.now();
  } finally {
    release();
  }
}

function canStart(priority: FplRequestPriority): boolean {
  if (inflight >= MAX_INFLIGHT) return false;
  if (priority === 'bulk') {
    maybeRecoverBulkLimit();
    if (bulkInflight >= adaptiveBulkLimit) return false;
  }
  return true;
}

function reserve(priority: FplRequestPriority): void {
  inflight += 1;
  if (priority === 'live') liveInflight += 1;
  else bulkInflight += 1;
}

function release(priority: FplRequestPriority): void {
  inflight -= 1;
  if (priority === 'live') liveInflight -= 1;
  else bulkInflight -= 1;
}

function maybeRecoverBulkLimit(now = Date.now()): void {
  if (
    adaptiveBulkLimit < BULK_MAX_INFLIGHT &&
    lastBulkErrorAt > 0 &&
    now - lastBulkErrorAt >= 5 * 60_000
  ) {
    adaptiveBulkLimit += 1;
    lastBulkErrorAt = adaptiveBulkLimit < BULK_MAX_INFLIGHT ? now : 0;
  }
}

/** Feed upstream health back into the shared scheduler without changing its
 * hard host-wide five-request ceiling.  Repeated 429/5xx responses shrink the
 * bulk lane from 3 to 2 to 1; five quiet minutes recover one slot at a time. */
export function reportFplResponse(
  priority: FplRequestPriority,
  status: number | null,
  now = Date.now(),
): void {
  if (priority !== 'bulk') return;
  if (status === 429 || (status !== null && status >= 500)) {
    adaptiveBulkLimit = Math.max(1, adaptiveBulkLimit - 1);
    lastBulkErrorAt = now;
    return;
  }
  maybeRecoverBulkLimit(now);
}

function drain(): void {
  while (waiters.length > 0) {
    const liveIndex = waiters.findIndex((waiter) => waiter.priority === 'live');
    const index = liveIndex >= 0 ? liveIndex : 0;
    const waiter = waiters[index];
    if (!canStart(waiter.priority)) return;
    waiters.splice(index, 1);
    reserve(waiter.priority);
    waiter.resolve();
  }
}

export async function acquireFplRequest(priority: FplRequestPriority): Promise<() => void> {
  if (canStart(priority)) {
    reserve(priority);
  } else {
    await new Promise<void>((resolve) => waiters.push({ priority, resolve }));
  }
  await waitForRateSlot();
  logDebug('FPL request admitted', {
    priority,
    inflight,
    liveInflight,
    bulkInflight,
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release(priority);
    drain();
  };
}

export function getFplAdmissionStats() {
  maybeRecoverBulkLimit();
  return {
    inflight,
    liveInflight,
    bulkInflight,
    queued: waiters.length,
    maxInflight: MAX_INFLIGHT,
    bulkMaxInflight: adaptiveBulkLimit,
    requestsPerSecond: 1_000 / MIN_INTERVAL_MS,
  };
}

export function resetFplAdmissionForTests(): void {
  inflight = 0;
  liveInflight = 0;
  bulkInflight = 0;
  lastStartedAt = 0;
  burstRemaining = RATE_BURST_SIZE;
  rateGate = Promise.resolve();
  adaptiveBulkLimit = BULK_MAX_INFLIGHT;
  lastBulkErrorAt = 0;
  waiters.splice(0);
}
