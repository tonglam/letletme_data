import { syncCoreSnapshot } from './core-snapshot.service';

/**
 * Teams Service - Business Logic Layer
 *
 * Handles all team-related operations:
 * - Data synchronization from FPL API
 * - Database operations
 */

// Sync teams from FPL API
export async function syncTeams(): Promise<{ count: number; errors: number }> {
  const result = await syncCoreSnapshot();
  return { count: result.teams, errors: result.failedUnits };
}
