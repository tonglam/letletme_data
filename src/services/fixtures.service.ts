import { fixturesCache, liveSnapshotCache } from '../cache/operations';
import { deriveSeasonFromFixtures } from '../cache/cache-season';
import { fplClient } from '../clients/fpl';
import {
  findOmittedEventFixtureIds,
  resolveFixtureCacheLockEventIds,
  resolveFixtureCacheTransitions,
  type FixtureCacheTransitions,
} from '../domain/fixture-cache-transition';
import { createFixtureRepository, fixtureRepository } from '../repositories/fixtures';
import { transformFixtures } from '../transformers/fixtures';
import type { Fixture, RawFPLFixture } from '../types';
import { logError, logInfo, logWarn } from '../utils/logger';
import { getCurrentEvent } from './events.service';
import { syncLiveBonusV2Cache } from './live-bonus.service';
import {
  syncLiveSnapshot,
  withFixtureSyncSerialization,
  withLiveSnapshotDurableEventsWriteFence,
} from './live-snapshot.service';

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

    type FixtureSyncContext = {
      rawFixtures: RawFPLFixture[];
      fixtures: Fixture[];
      recoveredFullFixtureFeed: boolean;
      unscheduledFixtures: Fixture[];
      schedulableFixtures: Fixture[];
      cacheSeason?: string;
      transitions: FixtureCacheTransitions;
    };

    const result = await withFixtureSyncSerialization(
      async (): Promise<{ eventIds: readonly number[]; context: FixtureSyncContext }> => {
        // Fetch only after entering the global fixture lane. The PostgreSQL
        // ordering token is already fixed by withFixtureSyncSerialization, so
        // a live snapshot that wins an event lock during this fetch makes the
        // later durable fence reject this payload.
        let rawFixtures = await fplClient.getFixtures(eventId);
        if (!Array.isArray(rawFixtures)) {
          throw new Error('Invalid fixtures data from FPL API');
        }
        logInfo('Raw fixtures data fetched', { count: rawFixtures.length, ...logContext });

        let fixtures = transformFixtures(rawFixtures);
        const eventScopedFixtureIds = new Set(fixtures.map((fixture) => fixture.id));
        let recoveredFullFixtureFeed = false;
        if (eventId) {
          const persistedEventFixtures = await fixtureRepository.findByEvent(eventId);
          const omittedFixtureIds = findOmittedEventFixtureIds(
            eventId,
            persistedEventFixtures,
            eventScopedFixtureIds,
          );
          if (omittedFixtureIds.length > 0) {
            const fullRawFixtures = await fplClient.getFixtures();
            if (!Array.isArray(fullRawFixtures) || fullRawFixtures.length === 0) {
              throw new Error(
                `Full fixture recovery returned no data for event ${eventId}; omitted fixture IDs: ${omittedFixtureIds.join(', ')}`,
              );
            }
            const fullFixtures = transformFixtures(fullRawFixtures);
            const fullFixtureIds = new Set(fullFixtures.map((fixture) => fixture.id));
            const unresolvedFixtureIds = omittedFixtureIds.filter(
              (fixtureId) => !fullFixtureIds.has(fixtureId),
            );
            if (unresolvedFixtureIds.length > 0) {
              throw new Error(
                `Full fixture recovery could not resolve omitted fixture IDs for event ${eventId}: ${unresolvedFixtureIds.join(', ')}`,
              );
            }
            rawFixtures = fullRawFixtures;
            fixtures = fullFixtures;
            recoveredFullFixtureFeed = true;
            logWarn('Promoted event-scoped fixture sync to full-feed recovery', {
              eventId,
              omittedFixtureIds,
              recoveredCount: fixtures.length,
            });
          }
        }

        const fixtureIds = fixtures.map((fixture) => fixture.id);
        const existingEvents = await fixtureRepository.findEventIdsByFixtureIds(fixtureIds);
        const transitions = resolveFixtureCacheTransitions(fixtures, existingEvents);
        const unscheduledFixtures = fixtures.filter((fixture) => fixture.event === null);
        const schedulableFixtures = fixtures.filter((fixture) => fixture.event !== null);
        logInfo('Fixtures transformed', {
          total: rawFixtures.length,
          successful: fixtures.length,
          errors: rawFixtures.length - fixtures.length,
          recoveredFullFixtureFeed,
          ...logContext,
        });

        return {
          eventIds: resolveFixtureCacheLockEventIds(fixtures, transitions.invalidatedEventIds),
          context: {
            rawFixtures,
            fixtures,
            recoveredFullFixtureFeed,
            unscheduledFixtures,
            schedulableFixtures,
            cacheSeason: deriveSeasonFromFixtures(rawFixtures) ?? undefined,
            transitions,
          },
        };
      },
      async (context, checkedAt, lockedEventIds) => {
        const {
          rawFixtures,
          fixtures,
          recoveredFullFixtureFeed,
          unscheduledFixtures,
          schedulableFixtures,
          cacheSeason,
          transitions,
        } = context;
        if (rawFixtures.length === 0) {
          logWarn('No fixtures returned from FPL API', logContext);
          return { count: 0, errors: 0 };
        }
        if (unscheduledFixtures.length > 0) {
          logWarn('Persisting only event ownership for unscheduled fixtures', {
            unscheduledCount: unscheduledFixtures.length,
            fixtureIds: unscheduledFixtures.map((fixture) => fixture.id),
          });
        }

        // Claim every affected event in one transaction. The callback runs only
        // if all claims win; Redis retirement precedes the fixture mutation so
        // a Redis failure still rolls back PostgreSQL ownership and checkpoints.
        const durable = await withLiveSnapshotDurableEventsWriteFence(
          lockedEventIds,
          checkedAt,
          async (tx) => {
            if (transitions.invalidatedEventIds.size > 0) {
              await Promise.all(
                Array.from(transitions.invalidatedEventIds).map((invalidatedEventId) =>
                  liveSnapshotCache.retire(invalidatedEventId),
                ),
              );
              logInfo('Retired live snapshots before fixture identity changes', {
                ...(eventId ? { eventId } : {}),
                invalidatedEventIds: Array.from(transitions.invalidatedEventIds),
              });
            }
            const repository = createFixtureRepository(tx);
            if (unscheduledFixtures.length > 0) {
              const markedUnscheduled = await repository.markUnscheduled(
                unscheduledFixtures.map((fixture) => fixture.id),
              );
              logInfo('Persisted unscheduled fixture ownership', {
                requested: unscheduledFixtures.length,
                updated: markedUnscheduled,
              });
            }
            return repository.upsertBatch(schedulableFixtures);
          },
        );
        if (!durable.accepted || !durable.value) {
          throw new Error(
            `Fixture sync for ${eventId ? `event ${eventId}` : 'all events'} was superseded by live snapshot event ${durable.rejectedEventId ?? 'unknown'} at ${durable.winnerCheckedAt.toISOString()}; retry`,
          );
        }
        const savedFixtures = durable.value;
        logInfo('Fixtures upserted to database', { count: savedFixtures.length, ...logContext });

        if (eventId && !recoveredFullFixtureFeed) {
          await fixturesCache.setByEvent(
            eventId,
            savedFixtures.filter((fixture) => fixture.event === eventId),
            cacheSeason,
          );
        } else {
          await fixturesCache.set([...savedFixtures, ...unscheduledFixtures], cacheSeason);
        }

        if (
          eventId &&
          !recoveredFullFixtureFeed &&
          transitions.unscheduledFixtureIdsToRemove.size > 0
        ) {
          await fixturesCache.removeUnscheduledFixtureIds([
            ...transitions.unscheduledFixtureIdsToRemove,
          ]);
        }

        // FPL can publish final fixture bonus stats after the live window
        // closes. Refresh from the rows just persisted rather than waiting
        // for a live-bonus cron that will no longer run.
        const bonusEventId =
          eventId && !recoveredFullFixtureFeed ? eventId : (await getCurrentEvent())?.id;
        if (bonusEventId) {
          const bonusFixtures = savedFixtures.filter((fixture) => fixture.event === bonusEventId);
          if (bonusFixtures.length > 0) {
            await syncLiveBonusV2Cache(bonusEventId, {
              fixtures: bonusFixtures,
              snapshotCoordinator: liveSnapshotCache,
            });
          }
        }
        logInfo('Fixtures cache updated', logContext);

        return {
          count: savedFixtures.length,
          errors: rawFixtures.length - fixtures.length,
        };
      },
    );

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

    // Final cache update with all fixtures. Keep it in the same mandatory lane
    // as normal fixture syncs so a later sync cannot be overwritten by this
    // backfill's trailing rebuild.
    await withFixtureSyncSerialization(
      async () => {
        const allFixtures = await fixtureRepository.findAll();
        return {
          eventIds: resolveFixtureCacheLockEventIds(allFixtures, new Set()),
          context: allFixtures,
        };
      },
      async (allFixtures) => {
        await fixturesCache.set(allFixtures);
      },
    );

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

// Compatibility service retained for callers outside BullMQ. Use the canonical
// coordinated publisher so no direct fixture upsert can race the six live views.
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

// Clear fixtures cache
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
