import { Elysia } from 'elysia';

import { clearFixturesCache, syncAllGameweeks, syncFixtures } from '../services/fixtures.service';

/**
 * Fixtures API Routes
 *
 * Handles all fixture-related HTTP endpoints:
 * - POST /fixtures/sync - Trigger fixtures sync (all or specific event)
 * - POST /fixtures/sync-all-gameweeks - Sync all 38 gameweeks
 * - DELETE /fixtures/cache - Clear fixtures cache
 */

export const fixturesAPI = new Elysia({ prefix: '/fixtures' })
  .post('/sync', async ({ query }) => {
    const eventId = query.event ? parseInt(query.event as string) : undefined;

    if (query.event && isNaN(eventId as number)) {
      return { success: false, error: 'Invalid event ID' };
    }

    const result = await syncFixtures(eventId);
    return {
      success: true,
      message: eventId ? `Fixtures sync completed for event ${eventId}` : 'Fixtures sync completed',
      ...result,
    };
  })

  .post('/sync-all-gameweeks', async () => {
    const result = await syncAllGameweeks();
    return {
      success: true,
      message: 'All gameweeks sync completed',
      totalCount: result.totalCount,
      totalErrors: result.totalErrors,
      gameweeks: result.perGameweek.length,
      details: result.perGameweek,
    };
  })

  .delete('/cache', async () => {
    await clearFixturesCache();
    return { success: true, message: 'Fixtures cache cleared' };
  });
