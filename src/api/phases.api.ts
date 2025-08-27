import { Elysia } from 'elysia';

import { clearPhasesCache, getPhase, getPhases, syncPhases } from '../services/phases.service';

/**
 * Phases API Routes
 *
 * Handles all phase-related HTTP endpoints:
 * - GET /phases - List all phases
 * - GET /phases/:id - Get specific phase
 * - POST /phases/sync - Trigger phases sync
 * - DELETE /phases/cache - Clear phases cache
 */

export const phasesAPI = new Elysia({ prefix: '/phases' })
  .get('/', async () => {
    const phases = await getPhases();
    return { success: true, data: phases, count: phases.length };
  })

  .get('/:id', async ({ params, set }) => {
    const id = parseInt(params.id);
    if (isNaN(id)) {
      set.status = 400;
      return { success: false, error: 'Invalid phase ID' };
    }

    const phase = await getPhase(id);
    if (!phase) {
      set.status = 404;
      return { success: false, error: 'Phase not found' };
    }

    return { success: true, data: phase };
  })

  .post('/sync', async () => {
    const result = await syncPhases();
    return { success: true, message: 'Phases sync completed', ...result };
  })

  .delete('/cache', async () => {
    await clearPhasesCache();
    return { success: true, message: 'Phases cache cleared' };
  });
