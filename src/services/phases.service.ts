import { phasesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { phaseRepository } from '../repositories/phases';
import { transformPhases } from '../transformers/phases';
import { logError, logInfo } from '../utils/logger';

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

    // 2. Transform to domain phases
    const phases = transformPhases(bootstrapData.phases);
    logInfo('Phases transformed', {
      total: bootstrapData.phases.length,
      successful: phases.length,
      errors: bootstrapData.phases.length - phases.length,
    });

    // Log first phase as example
    if (phases.length > 0) {
      logInfo('Sample transformed phase', {
        id: phases[0].id,
        name: phases[0].name,
        startEvent: phases[0].startEvent,
        stopEvent: phases[0].stopEvent,
      });
    }

    // 3. Save to database (batch upsert)
    const savedPhases = await phaseRepository.upsertBatch(phases);
    logInfo('Phases saved to database', { count: savedPhases.length });

    // 4. Update cache
    await phasesCache.set(phases);
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
