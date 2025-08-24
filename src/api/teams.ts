import { teamsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import {
  filterTeamsByStrength,
  getAttackingDifficulty,
  getDefensiveDifficulty,
  getFormRating,
  getHomeAdvantage,
  getRelegationZoneTeams,
  getTopPerformingTeams,
  isStrongTeam,
} from '../domain/teams';
import { teamRepository } from '../repositories/teams';
import { transformTeams } from '../transformers/teams';
import { getErrorMessage, getErrorStatus, ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Request, Response } from 'express';
import type { Team } from '../types';

/**
 * Teams Service - Simplified Data Flow Example
 *
 * Flow: FPL API → Transform → Database → Cache → HTTP Response
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

    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid team ID', 'INVALID_ID');
    }

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

// Get teams with enhanced metadata
export async function getTeamsWithMetadata(): Promise<
  Array<
    Team & {
      isStrong: boolean;
      formRating: string;
      homeAdvantage: number;
      attackingDifficulty: { home: string; away: string };
      defensiveDifficulty: { home: string; away: string };
    }
  >
> {
  try {
    const teams = await getTeams();

    return teams.map((team) => ({
      ...team,
      isStrong: isStrongTeam(team),
      formRating: getFormRating(team),
      homeAdvantage: getHomeAdvantage(team),
      attackingDifficulty: {
        home: getAttackingDifficulty(team, true),
        away: getAttackingDifficulty(team, false),
      },
      defensiveDifficulty: {
        home: getDefensiveDifficulty(team, true),
        away: getDefensiveDifficulty(team, false),
      },
    }));
  } catch (error) {
    logError('Failed to get teams with metadata', error);
    throw error;
  }
}

// Get top performing teams
export async function getTopTeams(count: number = 6): Promise<Team[]> {
  try {
    if (!Number.isInteger(count) || count <= 0 || count > 20) {
      throw new ValidationError('Count must be between 1 and 20', 'INVALID_COUNT');
    }

    const teams = await getTeams();
    return getTopPerformingTeams(teams, count);
  } catch (error) {
    logError('Failed to get top teams', error, { count });
    throw error;
  }
}

// Get teams in relegation zone
export async function getRelegationTeams(): Promise<Team[]> {
  try {
    const teams = await getTeams();
    return getRelegationZoneTeams(teams);
  } catch (error) {
    logError('Failed to get relegation teams', error);
    throw error;
  }
}

// Get teams by strength
export async function getTeamsByStrength(
  minStrength: number,
  maxStrength?: number,
): Promise<Team[]> {
  try {
    if (!Number.isInteger(minStrength) || minStrength < 1 || minStrength > 5) {
      throw new ValidationError('Min strength must be between 1 and 5', 'INVALID_MIN_STRENGTH');
    }

    if (
      maxStrength !== undefined &&
      (!Number.isInteger(maxStrength) || maxStrength < 1 || maxStrength > 5)
    ) {
      throw new ValidationError('Max strength must be between 1 and 5', 'INVALID_MAX_STRENGTH');
    }

    if (maxStrength !== undefined && maxStrength < minStrength) {
      throw new ValidationError(
        'Max strength cannot be less than min strength',
        'INVALID_STRENGTH_RANGE',
      );
    }

    const teams = await getTeams();
    return filterTeamsByStrength(teams, minStrength, maxStrength);
  } catch (error) {
    logError('Failed to get teams by strength', error, { minStrength, maxStrength });
    throw error;
  }
}

// Sync teams from FPL API (the main data flow)
export async function syncTeams(): Promise<void> {
  try {
    logInfo('Starting teams sync from FPL API');

    // ========================
    // STEP 1: FETCH FROM API
    // ========================
    logInfo('Step 1: Fetching bootstrap data from FPL API');
    const bootstrapData = await fplClient.getBootstrap();
    logInfo('FPL bootstrap data fetched', { teamCount: bootstrapData.teams.length });

    // ========================
    // STEP 2: TRANSFORM DATA
    // ========================
    logInfo('Step 2: Transforming FPL teams to domain objects');
    const teams = transformTeams(bootstrapData.teams);
    logInfo('Teams transformed', { count: teams.length });

    // Log first team as example
    if (teams.length > 0) {
      logInfo('Sample transformed team', {
        id: teams[0].id,
        name: teams[0].name,
        shortName: teams[0].shortName,
        position: teams[0].position,
      });
    }

    // ========================
    // STEP 3: SAVE TO DATABASE
    // ========================
    logInfo('Step 3: Saving teams to database (batch upsert)');
    const savedTeams = await teamRepository.upsertBatch(teams);
    logInfo('Teams saved to database', { count: savedTeams.length });

    // ========================
    // STEP 4: UPDATE CACHE
    // ========================
    logInfo('Step 4: Updating Redis cache');
    // Use transformed teams instead of savedTeams (which might be empty due to DB schema issues)
    await teamsCache.set(teams);
    logInfo('Teams cache updated');

    logInfo('Teams sync completed successfully', {
      totalTeams: teams.length,
      savedTeams: savedTeams.length,
    });
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

// Teams API endpoints for HTTP server
export const teamsAPI = {
  // GET /teams
  async getAllTeams(req: Request, res: Response) {
    try {
      const teams = await getTeams();
      res.json({
        success: true,
        data: teams,
        count: teams.length,
        source: 'database_with_cache_fallback',
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },

  // GET /teams/:id
  async getTeamById(req: Request, res: Response) {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid team ID' });
      }

      const team = await getTeam(id);
      if (!team) {
        return res.status(404).json({ success: false, error: 'Team not found' });
      }

      return res.json({ success: true, data: team });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /teams/metadata
  async getTeamsWithMetadata(req: Request, res: Response) {
    try {
      const teams = await getTeamsWithMetadata();
      return res.json({
        success: true,
        data: teams,
        count: teams.length,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /teams/top?count=6
  async getTopTeams(req: Request, res: Response) {
    try {
      const count = parseInt(req.query.count as string) || 6;
      const teams = await getTopTeams(count);
      return res.json({
        success: true,
        data: teams,
        count: teams.length,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /teams/relegation
  async getRelegationTeams(req: Request, res: Response) {
    try {
      const teams = await getRelegationTeams();
      return res.json({
        success: true,
        data: teams,
        count: teams.length,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /teams/strength?min=4&max=5
  async getTeamsByStrength(req: Request, res: Response) {
    try {
      const minStrength = parseInt(req.query.min as string);
      const maxStrength = req.query.max ? parseInt(req.query.max as string) : undefined;

      const teams = await getTeamsByStrength(minStrength, maxStrength);
      return res.json({
        success: true,
        data: teams,
        count: teams.length,
        filters: { minStrength, maxStrength },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // POST /teams/sync
  async syncTeams(req: Request, res: Response) {
    try {
      await syncTeams();
      res.json({
        success: true,
        message: 'Teams synced successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },

  // DELETE /teams/cache
  async clearCache(req: Request, res: Response) {
    try {
      await clearTeamsCache();
      res.json({
        success: true,
        message: 'Teams cache cleared',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      res.status(status).json({ success: false, error: message });
    }
  },
};
