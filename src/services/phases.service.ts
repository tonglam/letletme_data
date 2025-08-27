import { phasesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { phaseRepository } from '../repositories/phases';
import { transformPhases } from '../transformers/phases';
import type { Phase } from '../types';
import { logError, logInfo } from '../utils/logger';

/**
 * Phases Service - Business Logic Layer
 *
 * Handles all phase-related operations:
 * - Data synchronization from FPL API
 * - Cache management
 * - Database operations
 * - Data retrieval with fallbacks
 */

// Get all phases (with cache fallback)
export async function getPhases(): Promise<Phase[]> {
  try {
    logInfo('Getting all phases');

    // 1. Try cache first (fast path)
    const cached = await phasesCache.get();
    if (cached) {
      logInfo('Phases retrieved from cache', { count: Array.isArray(cached) ? cached.length : 0 });
      return cached as Phase[];
    }

    // 2. Fallback to database (slower path)
    const dbPhases = await phaseRepository.findAll();

    // 3. Update cache for next time
    if (dbPhases.length > 0) {
      await phasesCache.set(dbPhases);
    }

    logInfo('Phases retrieved from database', { count: dbPhases.length });
    return dbPhases;
  } catch (error) {
    logError('Failed to get phases', error);
    throw error;
  }
}

// Get single phase by ID
export async function getPhase(id: number): Promise<Phase | null> {
  try {
    logInfo('Getting phase by id', { id });

    const phase = await phaseRepository.findById(id);

    if (phase) {
      logInfo('Phase found', { id, name: phase.name });
    } else {
      logInfo('Phase not found', { id });
    }

    return phase;
  } catch (error) {
    logError('Failed to get phase', error, { id });
    throw error;
  }
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

// Clear phases cache
export async function clearPhasesCache(): Promise<void> {
  try {
    logInfo('Clearing phases cache');
    await phasesCache.clear();
    logInfo('Phases cache cleared');
  } catch (error) {
    logError('Failed to clear phases cache', error);
    throw error;
  }
}
