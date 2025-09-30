import { Elysia } from 'elysia';

import {
  clearFixturesCache,
  getFixture,
  getFixtures,
  getFixturesByEvent,
  getFixturesByTeam,
  syncAllGameweeks,
  syncFixtures,
} from '../services/fixtures.service';

/**
 * Fixtures API Routes
 *
 * Handles all fixture-related HTTP endpoints:
 * - GET /fixtures - List all fixtures
 * - GET /fixtures/:id - Get specific fixture
 * - GET /fixtures/event/:eventId - Get fixtures by event
 * - GET /fixtures/team/:teamId - Get fixtures by team
 * - POST /fixtures/sync - Trigger fixtures sync (all or specific event)
 * - POST /fixtures/sync-all-gameweeks - Sync all 38 gameweeks
 * - DELETE /fixtures/cache - Clear fixtures cache
 */

export const fixturesAPI = new Elysia({ prefix: '/fixtures' })
  .get('/', async () => {
    const fixtures = await getFixtures();
    return { success: true, data: fixtures, count: fixtures.length };
  })

  .get('/:id', async ({ params, set }) => {
    const id = parseInt(params.id);
    if (isNaN(id)) {
      set.status = 400;
      return { success: false, error: 'Invalid fixture ID' };
    }

    const fixture = await getFixture(id);
    if (!fixture) {
      set.status = 404;
      return { success: false, error: 'Fixture not found' };
    }

    return { success: true, data: fixture };
  })

  .get('/event/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const fixtures = await getFixturesByEvent(eventId);
    return { success: true, data: fixtures, count: fixtures.length };
  })

  .get('/team/:teamId', async ({ params, set }) => {
    const teamId = parseInt(params.teamId);
    if (isNaN(teamId)) {
      set.status = 400;
      return { success: false, error: 'Invalid team ID' };
    }

    const fixtures = await getFixturesByTeam(teamId);
    return { success: true, data: fixtures, count: fixtures.length };
  })

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
      message: `All gameweeks sync completed`,
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
