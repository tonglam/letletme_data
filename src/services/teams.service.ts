import { teamsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { teamRepository } from '../repositories/teams';
import { transformTeams } from '../transformers/teams';
import type { Team } from '../types';
import { logError, logInfo } from '../utils/logger';

/**
 * Teams Service - Business Logic Layer
 *
 * Handles all team-related operations:
 * - Data synchronization from FPL API
 * - Cache management
 * - Database operations
 * - Data retrieval with fallbacks
 */

// Get all teams (with cache fallback)
export async function getTeams(): Promise<Team[]> {
  try {
    logInfo('Getting all teams');

    // 1. Try cache first (fast path)
    const cached = await teamsCache.get();
    if (cached) {
      logInfo('Teams retrieved from cache', { count: Array.isArray(cached) ? cached.length : 0 });
      return cached as Team[];
    }

    // 2. Fallback to database (slower path)
    const dbTeams = await teamRepository.findAll();

    // 3. Update cache for next time
    if (dbTeams.length > 0) {
      await teamsCache.set(dbTeams);
    }

    logInfo('Teams retrieved from database', { count: dbTeams.length });
    return dbTeams;
  } catch (error) {
    logError('Failed to get teams', error);
    throw error;
  }
}

// Get single team by ID
export async function getTeam(id: number): Promise<Team | null> {
  try {
    logInfo('Getting team by id', { id });

    const team = await teamRepository.findById(id);

    if (team) {
      logInfo('Team found', { id, name: team.name });
    } else {
      logInfo('Team not found', { id });
    }

    return team;
  } catch (error) {
    logError('Failed to get team', error, { id });
    throw error;
  }
}

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

// Clear teams cache
export async function clearTeamsCache(): Promise<void> {
  try {
    logInfo('Clearing teams cache');
    await teamsCache.clear();
    logInfo('Teams cache cleared');
  } catch (error) {
    logError('Failed to clear teams cache', error);
    throw error;
  }
}
