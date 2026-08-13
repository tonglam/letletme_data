import type { FplSeasonRef } from '../domain/fpl-season';
import {
  playerMarketSnapshotsRepository,
  type PlayerMarketDayCoverage,
} from '../repositories/player-market-snapshots';
import { playerRepository } from '../repositories/players';
import { seasonRepository } from '../repositories/seasons';
import { logError, logInfo } from '../utils/logger';
import { notifyTwoBots } from '../utils/notify';
import { formatCronDateKey } from '../utils/timezone';
import { resolvePlayerSyncEvent, type PlayerSyncEvent } from './player-sync-event.service';

export type PlayerMarketFreshnessDependencies = {
  findCurrentSeason: () => Promise<FplSeasonRef>;
  resolveSyncEvent: (season: FplSeasonRef, now: Date) => Promise<PlayerSyncEvent | null>;
  countPublishedPlayers: (season: FplSeasonRef) => Promise<number>;
  getDayCoverage: (season: FplSeasonRef, snapshotDate: string) => Promise<PlayerMarketDayCoverage>;
  notify: (message: string) => Promise<void>;
};

const defaultDependencies: PlayerMarketFreshnessDependencies = {
  findCurrentSeason: () => seasonRepository.findCurrent(),
  resolveSyncEvent: (season, now) => resolvePlayerSyncEvent(season, now),
  countPublishedPlayers: (season) => playerRepository.countPublished(season),
  getDayCoverage: (season, snapshotDate) =>
    playerMarketSnapshotsRepository.getDayCoverage(season, snapshotDate),
  notify: notifyTwoBots,
};

export type PlayerMarketFreshnessResult =
  | { readonly status: 'skipped'; readonly reason: 'no-current-or-next-event' }
  | {
      readonly status: 'ready' | 'missing' | 'incomplete';
      readonly snapshotDate: string;
      readonly eventId: number;
      readonly expectedCount: number;
      readonly snapshotCount: number;
      readonly captureCount: number;
      readonly latestCapturedAt: string | null;
    };

export async function checkPlayerMarketFreshness(
  now: Date = new Date(),
  dependencies: PlayerMarketFreshnessDependencies = defaultDependencies,
): Promise<PlayerMarketFreshnessResult> {
  const season = await dependencies.findCurrentSeason();
  const syncEvent = await dependencies.resolveSyncEvent(season, now);
  if (!syncEvent) {
    const result = { status: 'skipped', reason: 'no-current-or-next-event' } as const;
    logInfo('Player market freshness watchdog skipped', result);
    return result;
  }

  const snapshotDate = formatCronDateKey(now);
  const [expectedCount, coverage] = await Promise.all([
    dependencies.countPublishedPlayers(season),
    dependencies.getDayCoverage(season, snapshotDate),
  ]);
  const status =
    coverage.snapshotCount === 0
      ? 'missing'
      : expectedCount > 0 && coverage.snapshotCount === expectedCount && coverage.captureCount === 1
        ? 'ready'
        : 'incomplete';
  const result = {
    status,
    snapshotDate,
    eventId: syncEvent.event.id,
    expectedCount,
    snapshotCount: coverage.snapshotCount,
    captureCount: coverage.captureCount,
    latestCapturedAt: coverage.latestCapturedAt?.toISOString() ?? null,
  } as const;

  if (status === 'ready') {
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
      ].join('\n'),
    );
  } catch (error) {
    // The notification fan-out is best effort and must not mutate readiness.
    logError('Failed to send player market freshness alert', error, result);
  }
  return result;
}
