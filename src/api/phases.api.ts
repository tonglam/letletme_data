import { Elysia } from 'elysia';

import { syncPhases } from '../services/phases.service';

/**
 * Phases API Routes
 *
 * Handles all phase-related HTTP endpoints:
 * - POST /phases/sync - Trigger phases sync
 */

export const phasesAPI = new Elysia({ prefix: '/phases' }).post('/sync', async () => {
  const result = await syncPhases();
  return { success: true, message: 'Phases sync completed', ...result };
});
