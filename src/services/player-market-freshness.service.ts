import { fplClient } from '../clients/fpl';
import { deriveFplSeasonFromEvents } from '../domain/fpl-source-season';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  playerMarketSnapshotsRepository,
  type PlayerMarketDayCoverage,
} from '../repositories/player-market-snapshots';
import { playerValuesRepository } from '../repositories/player-values';
import { seasonRepository } from '../repositories/seasons';
import type { PlayerValuesSettlement } from '../jobs/player-values-settlement';
import { logError, logInfo } from '../utils/logger';
import { notifyTwoBots } from '../utils/notify';
import { formatCronDateKey } from '../utils/timezone';
import { resolvePlayerSyncEvent, type PlayerSyncEvent } from './player-sync-event.service';
import { ensureMarketPublication } from './market-publication.service';

type NotificationOptions = { idempotencyKey?: string };

export type PlayerMarketFreshnessDependencies = {
  findCurrentSeason: () => Promise<FplSeasonRef>;
  resolveSyncEvent: (season: FplSeasonRef, now: Date) => Promise<PlayerSyncEvent | null>;
  countCurrentUpstreamPlayers: (season: FplSeasonRef) => Promise<number>;
  getDayCoverage: (season: FplSeasonRef, snapshotDate: string) => Promise<PlayerMarketDayCoverage>;
  hasChangesForDate: (season: FplSeasonRef, snapshotDate: string) => Promise<boolean>;
  waitForPlayerValuesSettlement: (
    season: FplSeasonRef,
    snapshotDate: string,
    options: { missingIsSettled: boolean; bullJobId?: string | number },
  ) => Promise<PlayerValuesSettlement>;
  notify: (message: string, options?: NotificationOptions) => Promise<void>;
  ensureMarketPublication?: typeof ensureMarketPublication;
};

const defaultDependencies: PlayerMarketFreshnessDependencies = {
  findCurrentSeason: () => seasonRepository.findCurrent(),
  resolveSyncEvent: (season, now) => resolvePlayerSyncEvent(season, now),
  countCurrentUpstreamPlayers: async (season) => {
    const bootstrap = await fplClient.getBootstrap();
    const sourceSeason = deriveFplSeasonFromEvents(bootstrap.events);
    if (sourceSeason !== season.seasonCode) {
      throw new Error(
        `Player market freshness source season mismatch: expected ${season.seasonCode}, received ${sourceSeason ?? 'unknown'}`,
      );
    }
    if (bootstrap.elements.length === 0) {
      throw new Error('Player market freshness bootstrap contains no players');
    }
    return bootstrap.elements.length;
  },
  getDayCoverage: (season, snapshotDate) =>
    playerMarketSnapshotsRepository.getDayCoverage(season, snapshotDate),
  hasChangesForDate: (season, snapshotDate) =>
    playerValuesRepository.hasChangesForDate(season, snapshotDate),
  waitForPlayerValuesSettlement: async (season, snapshotDate, options) => {
    // Keep Queue/Redis configuration out of pure service imports and unit tests.
    const { waitForPlayerValuesSettlement } = await import('../jobs/player-values-settlement');
    return waitForPlayerValuesSettlement(season, snapshotDate, options);
  },
  notify: notifyTwoBots,
  ensureMarketPublication,
};

export type PlayerMarketFreshnessResult =
  | { readonly status: 'skipped'; readonly reason: 'no-current-or-next-event' }
  | {
      readonly status: 'ready' | 'missing' | 'incomplete' | 'stale' | 'unsettled';
      readonly snapshotDate: string;
      readonly eventId: number;
      readonly phase: PlayerSyncEvent['phase'];
      readonly expectedCount: number;
      readonly snapshotCount: number;
      readonly captureCount: number;
      readonly latestCapturedAt: string | null;
      readonly hasChanges: boolean;
      readonly queueState: PlayerValuesSettlement['state'];
    };

function isFinalWindowCapture(snapshotDate: string, capturedAt: Date | null): boolean {
  if (!capturedAt || !Number.isFinite(capturedAt.getTime())) return false;
  if (formatCronDateKey(capturedAt) !== snapshotDate) return false;
  const year = Number(snapshotDate.slice(0, 4));
  const month = Number(snapshotDate.slice(4, 6));
  const day = Number(snapshotDate.slice(6, 8));
  // The final 07:05 Asia/Shanghai capture is 23:05 UTC on the previous day.
  const finalWindowStart = Date.UTC(year, month - 1, day, -1, 5);
  return capturedAt.getTime() >= finalWindowStart;
}

export async function checkPlayerMarketFreshness(
  now: Date = new Date(),
  dependencies: PlayerMarketFreshnessDependencies = defaultDependencies,
  options: {
    freshnessWindowId?: number;
    sourceRunId?: string;
    playerValuesBullJobId?: string | number;
  } = {},
): Promise<PlayerMarketFreshnessResult> {
  const season = await dependencies.findCurrentSeason();
  const syncEvent = await dependencies.resolveSyncEvent(season, now);
  if (!syncEvent) {
    const result = { status: 'skipped', reason: 'no-current-or-next-event' } as const;
    logInfo('Player market freshness watchdog skipped', result);
    return result;
  }

  const snapshotDate = formatCronDateKey(now);
  const [initialCoverage, initialHasChanges] = await Promise.all([
    dependencies.getDayCoverage(season, snapshotDate),
    dependencies.hasChangesForDate(season, snapshotDate),
  ]);
  const initialFinalCaptureObserved =
    syncEvent.phase === 'preseason' ||
    initialHasChanges ||
    isFinalWindowCapture(snapshotDate, initialCoverage.latestCapturedAt);
  // A 07:05 capture can legitimately be active or delayed by BullMQ backoff
  // when this 07:06 check begins. A missing queue row is conclusive only when
  // the final snapshot already proves completion; otherwise allow the producer
  // its full enqueue/retry horizon and distinguish a never-observed job.
  const settlement = await dependencies.waitForPlayerValuesSettlement(season, snapshotDate, {
    missingIsSettled: initialFinalCaptureObserved,
    bullJobId: options.playerValuesBullJobId,
  });
  const [expectedCount, coverage, hasChanges] = await Promise.all([
    // fpl.players is intentionally historical/accumulative. Compare against
    // the current official bootstrap instead so removed players cannot inflate
    // the watchdog's denominator forever.
    dependencies.countCurrentUpstreamPlayers(season),
    dependencies.getDayCoverage(season, snapshotDate),
    dependencies.hasChangesForDate(season, snapshotDate),
  ]);
  const completeSnapshot =
    expectedCount > 0 && coverage.snapshotCount === expectedCount && coverage.captureCount === 1;
  const finalCaptureObserved =
    syncEvent.phase === 'preseason' ||
    hasChanges ||
    isFinalWindowCapture(snapshotDate, coverage.latestCapturedAt);
  // A fast job can enqueue, finish, and be removed between queue polls. The
  // complete final capture is durable settlement evidence in that race.
  const captureSettled = settlement.settled || (completeSnapshot && finalCaptureObserved);
  const status = !captureSettled
    ? 'unsettled'
    : coverage.snapshotCount === 0
      ? 'missing'
      : completeSnapshot && finalCaptureObserved
        ? 'ready'
        : completeSnapshot
          ? 'stale'
          : 'incomplete';
  const result = {
    status,
    snapshotDate,
    eventId: syncEvent.event.id,
    phase: syncEvent.phase,
    expectedCount,
    snapshotCount: coverage.snapshotCount,
    captureCount: coverage.captureCount,
    latestCapturedAt: coverage.latestCapturedAt?.toISOString() ?? null,
    hasChanges,
    queueState: settlement.state,
  } as const;

  if (status === 'ready') {
    if (dependencies.ensureMarketPublication) {
      await dependencies.ensureMarketPublication(season, {
        freshnessWindowId: options.freshnessWindowId,
        sourceRunId: options.sourceRunId,
      });
    }
    logInfo('Player market freshness watchdog passed', result);
    return result;
  }

  logError('Player market freshness watchdog detected stale data', undefined, result);
  try {
    await dependencies.notify(
      [
        `[player-market-freshness] ${status}`,
        `Date: ${snapshotDate}`,
        `Event: ${syncEvent.event.id}`,
        `Expected: ${expectedCount}`,
        `Observed: ${coverage.snapshotCount}`,
        `Capture revisions: ${coverage.captureCount}`,
        `Latest capture: ${result.latestCapturedAt ?? 'none'}`,
        `Price changes observed: ${hasChanges}`,
        `Player-values queue: ${settlement.state}`,
      ].join('\n'),
      { idempotencyKey: `player-market-freshness:${scheduledRunUtcMinute(now)}` },
    );
  } catch (error) {
    // The notification fan-out is best effort and must not mutate readiness.
    logError('Failed to send player market freshness alert', error, result);
  }
  return result;
}

function scheduledRunUtcMinute(now: Date): string {
  return now.toISOString().slice(0, 16);
}
