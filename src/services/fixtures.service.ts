import { fixturesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { fixtureRepository } from '../repositories/fixtures';
import { transformFixtures } from '../transformers/fixtures';
import type { Fixture } from '../types';
import { logError, logInfo } from '../utils/logger';

/**
 * Fixtures Service - Business Logic Layer
 *
 * Handles all fixture-related operations:
 * - Data synchronization from FPL API
 * - Cache management
 * - Database operations
 * - Data retrieval with fallbacks
 */

// Get all fixtures (cache-first strategy: Redis → DB → update Redis)
export async function getFixtures(): Promise<Fixture[]> {
  try {
    logInfo('Getting all fixtures');

    // 1. Try cache first (fast path)
    const cached = await fixturesCache.getAll();
    if (cached) {
      logInfo('Fixtures retrieved from cache', { count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database');
    const dbFixtures = await fixtureRepository.findAll();

    // 3. Update cache for next time (async, don't block response)
    if (dbFixtures.length > 0) {
      fixturesCache.set(dbFixtures).catch((error) => {
        logError('Failed to update fixtures cache', error);
      });
    }

    logInfo('Fixtures retrieved from database', { count: dbFixtures.length });
    return dbFixtures;
  } catch (error) {
    logError('Failed to get fixtures', error);
    throw error;
  }
}

// Get single fixture by ID (cache-first strategy: Redis → DB → update Redis)
export async function getFixture(id: number): Promise<Fixture | null> {
  try {
    logInfo('Getting fixture by id', { id });

    // 1. Try cache first (fast path)
    const cached = await fixturesCache.getById(id);
    if (cached) {
      logInfo('Fixture retrieved from cache', { id });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { id });
    const fixture = await fixtureRepository.findById(id);

    if (fixture) {
      // 3. Update cache for next time (async, don't block response)
      fixturesCache.getAll().then((allFixtures) => {
        if (!allFixtures) {
          // If full cache doesn't exist, fetch all and cache
          fixtureRepository.findAll().then((dbFixtures) => {
            fixturesCache.set(dbFixtures).catch((error) => {
              logError('Failed to update fixtures cache', error);
            });
          });
        }
      });

      logInfo('Fixture found in database', { id });
    } else {
      logInfo('Fixture not found', { id });
    }

    return fixture;
  } catch (error) {
    logError('Failed to get fixture', error, { id });
    throw error;
  }
}

// Get fixtures by event (cache-first strategy: Redis → DB → update Redis)
export async function getFixturesByEvent(eventId: number): Promise<Fixture[]> {
  try {
    logInfo('Getting fixtures by event', { eventId });

    // 1. Try cache first (fast path)
    const cached = await fixturesCache.getByEvent(eventId);
    if (cached) {
      logInfo('Fixtures by event retrieved from cache', { eventId, count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { eventId });
    const dbFixtures = await fixtureRepository.findByEvent(eventId);

    // 3. Update cache for next time (async, don't block response)
    if (dbFixtures.length > 0) {
      fixturesCache.getAll().then((allFixtures) => {
        if (!allFixtures) {
          fixtureRepository.findAll().then((allDbFixtures) => {
            fixturesCache.set(allDbFixtures).catch((error) => {
              logError('Failed to update fixtures cache', error);
            });
          });
        }
      });
    }

    logInfo('Fixtures by event retrieved from database', { eventId, count: dbFixtures.length });
    return dbFixtures;
  } catch (error) {
    logError('Failed to get fixtures by event', error, { eventId });
    throw error;
  }
}

// Get fixtures by team (cache-first strategy: Redis → DB → update Redis)
export async function getFixturesByTeam(teamId: number): Promise<Fixture[]> {
  try {
    logInfo('Getting fixtures by team', { teamId });

    // 1. Try cache first (fast path)
    const cached = await fixturesCache.getByTeam(teamId);
    if (cached) {
      logInfo('Fixtures by team retrieved from cache', { teamId, count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { teamId });
    const dbFixtures = await fixtureRepository.findByTeam(teamId);

    // 3. Update cache for next time (async, don't block response)
    if (dbFixtures.length > 0) {
      fixturesCache.getAll().then((allFixtures) => {
        if (!allFixtures) {
          fixtureRepository.findAll().then((allDbFixtures) => {
            fixturesCache.set(allDbFixtures).catch((error) => {
              logError('Failed to update fixtures cache', error);
            });
          });
        }
      });
    }

    logInfo('Fixtures by team retrieved from database', { teamId, count: dbFixtures.length });
    return dbFixtures;
  } catch (error) {
    logError('Failed to get fixtures by team', error, { teamId });
    throw error;
  }
}

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

    // 2. Transform to domain fixtures
    const fixtures = transformFixtures(rawFixtures);
    logInfo('Fixtures transformed', {
      total: rawFixtures.length,
      successful: fixtures.length,
      errors: rawFixtures.length - fixtures.length,
      ...logContext,
    });

    // 3. Save to database (batch upsert)
    const savedFixtures = await fixtureRepository.upsertBatch(fixtures);
    logInfo('Fixtures upserted to database', { count: savedFixtures.length, ...logContext });

    // 4. Update cache with event-specific fixtures
    if (eventId) {
      // Cache fixtures for specific event
      await fixturesCache.setByEvent(eventId, savedFixtures);
    } else {
      // Cache all fixtures (grouped by event)
      await fixturesCache.set(savedFixtures);
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
    const allFixtures = await fixtureRepository.findAll();
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
