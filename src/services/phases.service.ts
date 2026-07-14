import { phasesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { phaseRepository } from '../repositories/phases';
import { transformPhases } from '../transformers/phases';
import { logError, logInfo } from '../utils/logger';
import { resolvePublishedSeasonFromEvents } from './cache-season.service';

/**
 * Phases Service - Business Logic Layer
 *
 * Handles all phase-related operations:
 * - Data synchronization from FPL API
 * - Database operations
 */

// Clear phases cache
export async function clearPhasesCache(): Promise<void> {
  await phasesCache.clear();
}

// Sync phases from FPL API
export async function syncPhases(): Promise<{ count: number; errors: number }> {
  try {
    logInfo('Starting phases sync from FPL API');

    // 1. Fetch from FPL API
    const bootstrapData = await fplClient.getBootstrap();

    if (!bootstrapData.phases || !Array.isArray(bootstrapData.phases)) {
      throw new Error('Invalid phases data from FPL API');
    }

    logInfo('FPL bootstrap data fetched', { phaseCount: bootstrapData.phases.length });

    if (bootstrapData.phases.length === 0) {
      logInfo('No phases returned from FPL API; preserving existing phases cache');
      return { count: 0, errors: 0 };
    }

    // 2. Transform to domain phases
    const phases = transformPhases(bootstrapData.phases);
    logInfo('Phases transformed', {
      total: bootstrapData.phases.length,
      successful: phases.length,
      errors: bootstrapData.phases.length - phases.length,
    });

    // 3. Save to database (batch upsert)
    const savedPhases = await phaseRepository.upsertBatch(phases);
    logInfo('Phases saved to database', { count: savedPhases.length });

    // 4. Update cache
    await phasesCache.set(phases, await resolvePublishedSeasonFromEvents(bootstrapData.events));
    logInfo('Phases cache updated');

    const result = {
      count: savedPhases.length,
      errors: bootstrapData.phases.length - phases.length,
    };

    logInfo('Phases sync completed successfully', result);
    return result;
  } catch (error) {
    logError('Phases sync failed', error);
    throw error;
  }
}
