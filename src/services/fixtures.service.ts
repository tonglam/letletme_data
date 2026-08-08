import { fixturesCache } from '../cache/operations';
import { fixtureRepository } from '../repositories/fixtures';
import { logError, logInfo } from '../utils/logger';
import { syncCoreSnapshot } from './core-snapshot.service';
import { syncLiveSnapshot } from './live-snapshot.service';

interface FixtureSyncOptions {
  /** Retained for source compatibility; core publication derives and fences the season itself. */
  publishedSeason?: string | null;
}

/** Route every non-Live fixture refresh through the complete core publisher. */
export async function syncFixtures(
  eventId?: number,
  _options: FixtureSyncOptions = {},
): Promise<{ count: number; errors: number }> {
  logInfo('Routing fixture refresh through the coherent core snapshot', {
    requestedEventId: eventId ?? null,
  });
  const result = await syncCoreSnapshot();
  return { count: result.fixtures, errors: result.failedUnits };
}

/** Compatibility alias for the retired per-gameweek backfill loop. */
export async function syncAllGameweeks(): Promise<{
  totalCount: number;
  totalErrors: number;
  perGameweek: Array<{ eventId: number; count: number; errors: number }>;
}> {
  const result = await syncCoreSnapshot();
  const fixtures = await fixtureRepository.findAll();
  const counts = new Map<number, number>();
  for (const fixture of fixtures) {
    if (fixture.event !== null) {
      counts.set(fixture.event, (counts.get(fixture.event) ?? 0) + 1);
    }
  }
  return {
    totalCount: result.fixtures,
    totalErrors: result.failedUnits,
    perGameweek: Array.from({ length: 38 }, (_, index) => ({
      eventId: index + 1,
      count: counts.get(index + 1) ?? 0,
      errors: 0,
    })),
  };
}

// Live publication remains owned by the separately managed Live pipeline.
export async function syncLiveScores(eventId: number): Promise<{ updated: number }> {
  try {
    const snapshot = await syncLiveSnapshot(eventId, { persistEventLives: false });
    const updated = snapshot.persistedFixtures ? snapshot.fixtureCount : 0;
    logInfo('Live scores compatibility sync completed through live snapshot', {
      eventId,
      updated,
      revision: snapshot.revision,
      stale: snapshot.stale,
    });
    return { updated };
  } catch (error) {
    logError('Live scores sync failed', error, { eventId });
    throw error;
  }
}

export async function clearFixturesCache(): Promise<void> {
  try {
    logInfo('Clearing fixtures cache');
    await Promise.all([fixturesCache.clear(), fixturesCache.clearAllByTeam()]);
    logInfo('Fixtures cache cleared');
  } catch (error) {
    logError('Failed to clear fixtures cache', error);
    throw error;
  }
}
