import { Elysia } from 'elysia';

import { clearTeamsCache, getTeam, getTeams, syncTeams } from '../services/teams.service';

/**
 * Teams API Routes
 *
 * Handles all team-related HTTP endpoints:
 * - GET /teams - List all teams
 * - GET /teams/:id - Get specific team
 * - POST /teams/sync - Trigger teams sync
 * - DELETE /teams/cache - Clear teams cache
 */

export const teamsAPI = new Elysia({ prefix: '/teams' })
  .get('/', async () => {
    const teams = await getTeams();
    return { success: true, data: teams, count: teams.length };
  })

  .get('/:id', async ({ params, set }) => {
    const id = parseInt(params.id);
    if (isNaN(id)) {
      set.status = 400;
      return { success: false, error: 'Invalid team ID' };
    }

    const team = await getTeam(id);
    if (!team) {
      set.status = 404;
      return { success: false, error: 'Team not found' };
    }

    return { success: true, data: team };
  })

  .post('/sync', async () => {
    const result = await syncTeams();
    return { success: true, message: 'Teams sync completed', ...result };
  })

  .delete('/cache', async () => {
    await clearTeamsCache();
    return { success: true, message: 'Teams cache cleared' };
  });
