import type { JobState } from 'bullmq';

import type { FplSeasonRef } from '../domain/fpl-season';
import { getExplicitDataSyncQueueJobId } from './data-sync-job-definition';

const PLAYER_VALUES_SETTLEMENT_TIMEOUT_MS = 5 * 60_000;
const PLAYER_VALUES_SETTLEMENT_POLL_MS = 2_000;
export type ObservedPlayerValuesJobState = JobState | 'unknown' | 'removed';
const SETTLED_STATES = new Set<ObservedPlayerValuesJobState>(['completed', 'failed', 'unknown']);

export type PlayerValuesSettlement = {
  readonly settled: boolean;
  readonly state: ObservedPlayerValuesJobState;
};

export function getPlayerValuesQueueJobId(season: FplSeasonRef, changeDate: string): string {
  return getExplicitDataSyncQueueJobId(season, `player-values-${changeDate}`);
}

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

async function readPlayerValuesJobState(
  season: FplSeasonRef,
  changeDate: string,
): Promise<ObservedPlayerValuesJobState> {
  const { dataSyncQueue } = await import('../queues/data-sync.queue');
  const job = await dataSyncQueue.getJob(getPlayerValuesQueueJobId(season, changeDate));
  return job ? job.getState() : 'removed';
}

/**
 * The 09:36 watchdog starts immediately after the capture window, but the
 * deterministic 09:35 job may still be active or in BullMQ backoff. Wait only
 * for that read-only queue state to settle; a timeout is evidence of a stuck
 * capture rather than a reason to emit an early stale-data alert.
 */
export async function waitForPlayerValuesSettlement(
  season: FplSeasonRef,
  changeDate: string,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    sleep?: (durationMs: number) => Promise<void>;
    readState?: () => Promise<ObservedPlayerValuesJobState>;
  } = {},
): Promise<PlayerValuesSettlement> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? PLAYER_VALUES_SETTLEMENT_TIMEOUT_MS);
  const pollMs = Math.max(1, options.pollMs ?? PLAYER_VALUES_SETTLEMENT_POLL_MS);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const readState = options.readState ?? (() => readPlayerValuesJobState(season, changeDate));
  const deadline = now() + timeoutMs;

  while (true) {
    const state = await readState();
    if (state === 'removed' || SETTLED_STATES.has(state)) {
      return { settled: true, state };
    }
    if (now() >= deadline) {
      return { settled: false, state };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
