import { phasesCache } from '../cache/operations';
import { syncCoreSnapshot } from './core-snapshot.service';

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
  const result = await syncCoreSnapshot();
  return { count: result.phases, errors: result.failedUnits };
}
