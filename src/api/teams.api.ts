import { Elysia } from 'elysia';

import { syncTeams } from '../services/teams.service';

/**
 * Teams API Routes
 *
 * Handles all team-related HTTP endpoints:
 * - POST /teams/sync - Trigger teams sync
 */

export const teamsAPI = new Elysia({ prefix: '/teams' }).post('/sync', async () => {
  const result = await syncTeams();
  return { success: true, message: 'Teams sync completed', ...result };
});
