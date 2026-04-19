import { fixturesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { fixtureRepository } from '../repositories/fixtures';
import { transformFixtures } from '../transformers/fixtures';
import { loadAllFixtures } from '../utils/fixtures';
import { logError, logInfo, logWarn } from '../utils/logger';

/**
 * Fixtures Service - Business Logic Layer
 *
 * Handles fixture operations focused on synchronization and cache management.
 */

// Sync all fixtures from FPL API
export async function syncFixtures(eventId?: number): Promise<{ count: number; errors: number }> {
  try {
    const logContext = eventId ? { eventId } : {};
    logInfo('Starting fixtures sync from FPL API', logContext);

    // 1. Fetch from FPL API
    const rawFixtures = await fplClient.getFixtures(eventId);

    if (!Array.isArray(rawFixtures)) {
      throw new Error('Invalid fixtures data from FPL API');
    }

    logInfo('Raw fixtures data fetched', { count: rawFixtures.length, ...logContext });

    if (rawFixtures.length === 0) {
      logWarn('No fixtures returned from FPL API', logContext);
      return { count: 0, errors: 0 };
    }

    let staleEventIds: Set<number> | null = null;
    let shouldClearUnscheduled = false;

    if (eventId) {
      const fixtureIds = rawFixtures
        .map((fixture) => fixture.id)
        .filter((fixtureId) => Number.isInteger(fixtureId));
      const existingEvents = await fixtureRepository.findEventIdsByFixtureIds(fixtureIds);
      staleEventIds = new Set<number>();

      for (const existingEventId of existingEvents.values()) {
        if (existingEventId === null) {
          shouldClearUnscheduled = true;
        } else if (existingEventId !== eventId) {
          staleEventIds.add(existingEventId);
        }
      }
    }

    // 2. Transform to domain fixtures
    const fixtures = transformFixtures(rawFixtures);
    logInfo('Fixtures transformed', {
      total: rawFixtures.length,
      successful: fixtures.length,
      errors: rawFixtures.length - fixtures.length,
      ...logContext,
    });

    const unscheduledFixtures = fixtures.filter((fixture) => fixture.event === null);
    const schedulableFixtures = fixtures.filter((fixture) => fixture.event !== null);

    if (unscheduledFixtures.length > 0) {
      // Some FPL fixtures can be temporarily unscheduled (event = null).
      // Current DB schema in production may reject null event_id, so skip DB upsert for these
      // while still allowing scheduled fixtures to sync successfully.
      logWarn('Skipping unscheduled fixtures for DB upsert', {
        unscheduledCount: unscheduledFixtures.length,
        fixtureIds: unscheduledFixtures.map((fixture) => fixture.id),
      });
    }

    // 3. Save scheduled fixtures to database (batch upsert)
    const savedFixtures = await fixtureRepository.upsertBatch(schedulableFixtures);
    logInfo('Fixtures upserted to database', { count: savedFixtures.length, ...logContext });

    // 4. Update cache with event-specific fixtures
    if (eventId) {
      // Cache fixtures for specific event
      await fixturesCache.setByEvent(eventId, savedFixtures);
    } else {
      // Cache all fixtures (grouped by event), including unscheduled records directly from FPL.
      await fixturesCache.set([...savedFixtures, ...unscheduledFixtures]);
    }

    if (eventId && staleEventIds && staleEventIds.size > 0) {
      await Promise.all(
        Array.from(staleEventIds).map((staleEventId) => fixturesCache.clearByEvent(staleEventId)),
      );
      logInfo('Cleared stale fixture caches', {
        eventId,
        staleEventIds: Array.from(staleEventIds),
      });
    }

    if (eventId && shouldClearUnscheduled) {
      await fixturesCache.clearUnscheduled();
      logInfo('Cleared unscheduled fixture cache after event sync', { eventId });
    }
    logInfo('Fixtures cache updated', logContext);

    const result = {
      count: savedFixtures.length,
      errors: rawFixtures.length - fixtures.length,
    };

    logInfo('Fixtures sync completed successfully', result);
    return result;
  } catch (error) {
    logError('Fixtures sync failed', error, eventId ? { eventId } : {});
    throw error;
  }
}

// Sync all fixtures for all gameweeks (1-38)
export async function syncAllGameweeks(): Promise<{
  totalCount: number;
  totalErrors: number;
  perGameweek: Array<{ eventId: number; count: number; errors: number }>;
}> {
  try {
    logInfo('Starting comprehensive fixtures sync for all gameweeks');

    const results: Array<{ eventId: number; count: number; errors: number }> = [];
    let totalCount = 0;
    let totalErrors = 0;

    // FPL has 38 gameweeks
    for (let eventId = 1; eventId <= 38; eventId++) {
      try {
        logInfo(`Syncing gameweek ${eventId}/38`);

        const result = await syncFixtures(eventId);
        results.push({ eventId, count: result.count, errors: result.errors });

        totalCount += result.count;
        totalErrors += result.errors;

        logInfo(`Gameweek ${eventId} synced`, {
          count: result.count,
          errors: result.errors,
        });

        // Small delay to avoid overwhelming the API
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        logError(`Failed to sync gameweek ${eventId}`, error);
        results.push({ eventId, count: 0, errors: 1 });
        totalErrors += 1;
      }
    }

    // Final cache update with all fixtures
    const allFixtures = await loadAllFixtures();
    await fixturesCache.set(allFixtures);

    logInfo('All gameweeks sync completed', {
      totalCount,
      totalErrors,
      gameweeks: results.length,
    });

    return {
      totalCount,
      totalErrors,
      perGameweek: results,
    };
  } catch (error) {
    logError('All gameweeks sync failed', error);
    throw error;
  }
}

// Sync live match scores for in-progress fixtures only (runs every 15 min during matches)
// Distinct from syncFixtures: targets only started+unfinished fixtures, no cache update
export async function syncLiveScores(eventId: number): Promise<{ updated: number }> {
  try {
    logInfo('Starting live scores sync', { eventId });

    const rawFixtures = await fplClient.getFixtures(eventId);

    if (!Array.isArray(rawFixtures)) {
      throw new Error('Invalid fixtures data from FPL API');
    }

    const inProgress = rawFixtures.filter((f) => f.started === true && f.finished === false);

    if (inProgress.length === 0) {
      logInfo('No in-progress fixtures to sync', { eventId });
      return { updated: 0 };
    }

    const fixtures = transformFixtures(inProgress);
    const saved = await fixtureRepository.upsertBatch(fixtures);

    logInfo('Live scores synced', { eventId, updated: saved.length });
    return { updated: saved.length };
  } catch (error) {
    logError('Live scores sync failed', error, { eventId });
    throw error;
  }
}

// Clear fixtures cache
export async function clearFixturesCache(): Promise<void> {
  try {
    logInfo('Clearing fixtures cache');
    await fixturesCache.clear();
    logInfo('Fixtures cache cleared');
  } catch (error) {
    logError('Failed to clear fixtures cache', error);
    throw error;
  }
}
