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

// Get all teams (cache-first strategy: Redis → DB → update Redis)
export async function getTeams(): Promise<Team[]> {
  try {
    logInfo('Getting all teams');

    // 1. Try cache first (fast path)
    const cached = await teamsCache.getAll();
    if (cached) {
      logInfo('Teams retrieved from cache', { count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database');
    const dbTeams = await teamRepository.findAll();

    // 3. Update cache for next time (async, don't block response)
    if (dbTeams.length > 0) {
      teamsCache.set(dbTeams).catch((error) => {
        logError('Failed to update teams cache', error);
      });
    }

    logInfo('Teams retrieved from database', { count: dbTeams.length });
    return dbTeams;
  } catch (error) {
    logError('Failed to get teams', error);
    throw error;
  }
}

// Get single team by ID (cache-first strategy: Redis → DB → update Redis)
export async function getTeam(id: number): Promise<Team | null> {
  try {
    logInfo('Getting team by id', { id });

    // 1. Try cache first (fast path)
    const cached = await teamsCache.getById(id);
    if (cached) {
      logInfo('Team retrieved from cache', { id, name: cached.name });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { id });
    const team = await teamRepository.findById(id);

    if (team) {
      // 3. Update cache for next time (async, don't block response)
      teamsCache.getAll().then((allTeams) => {
        if (!allTeams) {
          // If full cache doesn't exist, fetch all and cache
          teamRepository.findAll().then((dbTeams) => {
            teamsCache.set(dbTeams).catch((error) => {
              logError('Failed to update teams cache', error);
            });
          });
        }
      });

      logInfo('Team found in database', { id, name: team.name });
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
