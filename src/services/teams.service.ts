import { teamsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { teamRepository } from '../repositories/teams';
import { transformTeams } from '../transformers/teams';
import { logError, logInfo } from '../utils/logger';

/**
 * Teams Service - Business Logic Layer
 *
 * Handles all team-related operations:
 * - Data synchronization from FPL API
 * - Database operations
 */

// Sync teams from FPL API
export async function syncTeams(): Promise<{ count: number; errors: number }> {
  try {
    logInfo('Starting teams sync from FPL API');

    // 1. Fetch from FPL API
    const bootstrapData = await fplClient.getBootstrap();

    if (!bootstrapData.teams || !Array.isArray(bootstrapData.teams)) {
      throw new Error('Invalid teams data from FPL API');
    }

    logInfo('FPL bootstrap data fetched', { teamCount: bootstrapData.teams.length });

    // 2. Transform to domain teams
    const teams = transformTeams(bootstrapData.teams);
    logInfo('Teams transformed', {
      total: bootstrapData.teams.length,
      successful: teams.length,
      errors: bootstrapData.teams.length - teams.length,
    });

    // Log first team as example
    if (teams.length > 0) {
      logInfo('Sample transformed team', {
        id: teams[0].id,
        name: teams[0].name,
        shortName: teams[0].shortName,
        position: teams[0].position,
      });
    }

    // 3. Save to database (batch upsert)
    const savedTeams = await teamRepository.upsertBatch(teams);
    logInfo('Teams saved to database', { count: savedTeams.length });

    // 4. Update cache
    await teamsCache.set(teams);
    logInfo('Teams cache updated');

    const result = {
      count: savedTeams.length,
      errors: bootstrapData.teams.length - teams.length,
    };

    logInfo('Teams sync completed successfully', result);
    return result;
  } catch (error) {
    logError('Teams sync failed', error);
    throw error;
  }
}
