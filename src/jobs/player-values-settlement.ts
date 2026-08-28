import type { JobState } from 'bullmq';

import type { FplSeasonRef } from '../domain/fpl-season';
import {
  getSchedulerObligationByIdentity,
  type SchedulerObligation,
} from '../repositories/scheduler-obligations';
import { getExplicitDataSyncQueueJobId } from './data-sync-job-definition';

const PLAYER_VALUES_SETTLEMENT_TIMEOUT_MS = 5 * 60_000;
const PLAYER_VALUES_SETTLEMENT_POLL_MS = 2_000;
export type ObservedPlayerValuesJobState = JobState | 'unknown' | 'missing';
export type PlayerValuesSettlementState = JobState | 'unknown' | 'removed' | 'not-observed';
const SETTLED_STATES = new Set<JobState | 'unknown'>(['completed', 'failed', 'unknown']);

export type PlayerValuesSettlement = {
  readonly settled: boolean;
  readonly state: PlayerValuesSettlementState;
};

export function getPlayerValuesQueueJobId(season: FplSeasonRef, changeDate: string): string {
  return getExplicitDataSyncQueueJobId(season, `player-values-${changeDate}`);
}

export function getPlayerValuesSchedulerQueueJobId(
  season: FplSeasonRef,
  obligation: Pick<SchedulerObligation, 'obligationId' | 'generation' | 'bullJobId'>,
): string {
  if (obligation.bullJobId) return obligation.bullJobId;
  return getExplicitDataSyncQueueJobId(
    season,
    `scheduler-${obligation.obligationId}-g${obligation.generation}`,
  );
}

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, durationMs);
  });

async function readPlayerValuesJobState(
  season: FplSeasonRef,
  changeDate: string,
  bullJobId?: string | number,
): Promise<ObservedPlayerValuesJobState> {
  const { dataSyncQueue } = await import('../queues/data-sync.queue');
  const schedulerObligation = bullJobId
    ? null
    : await getSchedulerObligationByIdentity({
        jobName: 'market-daily',
        scopeKey: season.seasonCode,
        periodKey: changeDate,
      });
  const resolvedBullJobId = bullJobId
    ? String(bullJobId)
    : schedulerObligation
      ? getPlayerValuesSchedulerQueueJobId(season, schedulerObligation)
      : getPlayerValuesQueueJobId(season, changeDate);
  const job = await dataSyncQueue.getJob(resolvedBullJobId);
  return job ? job.getState() : 'missing';
}

/**
 * The 07:06 watchdog starts immediately after the capture window, but the
 * deterministic 07:05 job may still be active or in BullMQ backoff. Wait only
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
    /** Actual standalone market-daily Bull identity, when already resolved. */
    bullJobId?: string | number;
    /** Existing durable capture evidence proves an already-removed job settled. */
    missingIsSettled?: boolean;
  } = {},
): Promise<PlayerValuesSettlement> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? PLAYER_VALUES_SETTLEMENT_TIMEOUT_MS);
  const pollMs = Math.max(1, options.pollMs ?? PLAYER_VALUES_SETTLEMENT_POLL_MS);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const readState =
    options.readState ?? (() => readPlayerValuesJobState(season, changeDate, options.bullJobId));
  const deadline = now() + timeoutMs;
  let observedJob = false;

  while (true) {
    const state = await readState();
    if (state === 'missing') {
      if (observedJob || options.missingIsSettled) {
        return { settled: true, state: 'removed' };
      }
    } else {
      observedJob = true;
      if (SETTLED_STATES.has(state)) {
        return { settled: true, state };
      }
    }
    if (now() >= deadline) {
      return {
        settled: false,
        state: state === 'missing' ? 'not-observed' : state,
      };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
