import { phasesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import {
  filterPhasesByStatus,
  filterPhasesByType,
  findPhaseByGameweek,
  getHighestScoringPhase,
  getMonthlyPhases,
  getOverallPhase,
  getPhaseProgress,
  getPhaseStatus,
  getPhasesWithScores,
  getPhaseType,
  getRemainingGameweeks,
  isPhaseActive,
  isPhaseFinished,
  sortPhasesByHighestScore,
} from '../domain/phases';
import { phaseRepository } from '../repositories/phases';
import { transformPhases } from '../transformers/phases';
import { getErrorMessage, getErrorStatus, ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Request, Response } from 'express';
import type { Phase } from '../types';

/**
 * Phases Service - FPL Season Phases Management
 *
 * Flow: FPL API → Transform → Database → Cache → HTTP Response
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

    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid phase ID', 'INVALID_ID');
    }

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

// Get phases with enhanced metadata
export async function getPhasesWithMetadata(currentGameweek?: number): Promise<
  Array<
    Phase & {
      type: string;
      status: string;
      progress: number | null;
      remainingGameweeks: number | null;
      isActive: boolean;
      isFinished: boolean;
      hasHighestScore: boolean;
    }
  >
> {
  try {
    const phases = await getPhases();
    const gameweek = currentGameweek || 1; // Default to gameweek 1 if not provided

    return phases.map((phase) => ({
      ...phase,
      type: getPhaseType(phase),
      status: getPhaseStatus(phase, gameweek),
      progress: getPhaseProgress(phase, gameweek),
      remainingGameweeks: getRemainingGameweeks(phase, gameweek),
      isActive: isPhaseActive(phase, gameweek),
      isFinished: isPhaseFinished(phase, gameweek),
      hasHighestScore: phase.highestScore !== null && phase.highestScore > 0,
    }));
  } catch (error) {
    logError('Failed to get phases with metadata', error);
    throw error;
  }
}

// Get the overall season phase
export async function getOverallSeasonPhase(): Promise<Phase | null> {
  try {
    const phases = await getPhases();
    return getOverallPhase(phases);
  } catch (error) {
    logError('Failed to get overall season phase', error);
    throw error;
  }
}

// Get all monthly phases
export async function getMonthlySeasonPhases(): Promise<Phase[]> {
  try {
    const phases = await getPhases();
    return getMonthlyPhases(phases);
  } catch (error) {
    logError('Failed to get monthly phases', error);
    throw error;
  }
}

// Get phases by status
export async function getPhasesByStatus(
  status: 'upcoming' | 'active' | 'finished',
  currentGameweek: number = 1,
): Promise<Phase[]> {
  try {
    if (!['upcoming', 'active', 'finished'].includes(status)) {
      throw new ValidationError('Invalid status', 'INVALID_STATUS');
    }

    if (!Number.isInteger(currentGameweek) || currentGameweek < 1 || currentGameweek > 38) {
      throw new ValidationError('Current gameweek must be between 1 and 38', 'INVALID_GAMEWEEK');
    }

    const phases = await getPhases();
    return filterPhasesByStatus(phases, status, currentGameweek);
  } catch (error) {
    logError('Failed to get phases by status', error, { status, currentGameweek });
    throw error;
  }
}

// Get phases by type
export async function getPhasesByType(type: 'overall' | 'monthly' | 'custom'): Promise<Phase[]> {
  try {
    if (!['overall', 'monthly', 'custom'].includes(type)) {
      throw new ValidationError('Invalid type', 'INVALID_TYPE');
    }

    const phases = await getPhases();
    return filterPhasesByType(phases, type);
  } catch (error) {
    logError('Failed to get phases by type', error, { type });
    throw error;
  }
}

// Find phase by gameweek
export async function getPhaseByGameweek(gameweek: number): Promise<Phase | null> {
  try {
    if (!Number.isInteger(gameweek) || gameweek < 1 || gameweek > 38) {
      throw new ValidationError('Gameweek must be between 1 and 38', 'INVALID_GAMEWEEK');
    }

    const phases = await getPhases();
    return findPhaseByGameweek(phases, gameweek);
  } catch (error) {
    logError('Failed to get phase by gameweek', error, { gameweek });
    throw error;
  }
}

// Get phases with highest scores
export async function getPhasesWithHighestScores(): Promise<Phase[]> {
  try {
    const phases = await getPhases();
    return getPhasesWithScores(phases);
  } catch (error) {
    logError('Failed to get phases with highest scores', error);
    throw error;
  }
}

// Get the highest scoring phase
export async function getTopScoringPhase(): Promise<Phase | null> {
  try {
    const phases = await getPhases();
    return getHighestScoringPhase(phases);
  } catch (error) {
    logError('Failed to get top scoring phase', error);
    throw error;
  }
}

// Sync phases from FPL API (the main data flow)
export async function syncPhases(): Promise<void> {
  try {
    logInfo('Starting phases sync from FPL API');

    // ========================
    // STEP 1: FETCH FROM API
    // ========================
    logInfo('Step 1: Fetching bootstrap data from FPL API');
    const bootstrapData = await fplClient.getBootstrap();
    logInfo('FPL bootstrap data fetched', { phaseCount: bootstrapData.phases.length });

    // ========================
    // STEP 2: TRANSFORM DATA
    // ========================
    logInfo('Step 2: Transforming FPL phases to domain objects');
    const phases = transformPhases(bootstrapData.phases);
    logInfo('Phases transformed', { count: phases.length });

    // Log first phase as example
    if (phases.length > 0) {
      logInfo('Sample transformed phase', {
        id: phases[0].id,
        name: phases[0].name,
        startEvent: phases[0].startEvent,
        stopEvent: phases[0].stopEvent,
      });
    }

    // ========================
    // STEP 3: SAVE TO DATABASE
    // ========================
    logInfo('Step 3: Saving phases to database (batch upsert)');
    const savedPhases = await phaseRepository.upsertBatch(phases);
    logInfo('Phases saved to database', { count: savedPhases.length });

    // ========================
    // STEP 4: UPDATE CACHE
    // ========================
    logInfo('Step 4: Updating Redis cache');
    await phasesCache.set(phases);
    logInfo('Phases cache updated');

    logInfo('Phases sync completed successfully', {
      totalPhases: phases.length,
      savedPhases: savedPhases.length,
    });
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

// Phases API endpoints for HTTP server
export const phasesAPI = {
  // GET /phases
  async getAllPhases(req: Request, res: Response) {
    try {
      const phases = await getPhases();
      return res.json({
        success: true,
        data: phases,
        count: phases.length,
        source: 'database_with_cache_fallback',
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/:id
  async getPhaseById(req: Request, res: Response) {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid phase ID' });
      }

      const phase = await getPhase(id);
      if (!phase) {
        return res.status(404).json({ success: false, error: 'Phase not found' });
      }

      return res.json({ success: true, data: phase });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/metadata?gameweek=2
  async getPhasesWithMetadata(req: Request, res: Response) {
    try {
      const gameweek = req.query.gameweek ? parseInt(req.query.gameweek as string) : undefined;
      const phases = await getPhasesWithMetadata(gameweek);
      return res.json({
        success: true,
        data: phases,
        count: phases.length,
        gameweek: gameweek || 1,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/overall
  async getOverallPhase(req: Request, res: Response) {
    try {
      const phase = await getOverallSeasonPhase();
      if (!phase) {
        return res.status(404).json({ success: false, error: 'Overall phase not found' });
      }

      return res.json({ success: true, data: phase });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/monthly
  async getMonthlyPhases(req: Request, res: Response) {
    try {
      const phases = await getMonthlySeasonPhases();
      return res.json({
        success: true,
        data: phases,
        count: phases.length,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/status/:status?gameweek=2
  async getPhasesByStatus(req: Request, res: Response) {
    try {
      const status = req.params.status as 'upcoming' | 'active' | 'finished';
      const gameweek = parseInt(req.query.gameweek as string) || 1;

      const phases = await getPhasesByStatus(status, gameweek);
      return res.json({
        success: true,
        data: phases,
        count: phases.length,
        filters: { status, gameweek },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/type/:type
  async getPhasesByType(req: Request, res: Response) {
    try {
      const type = req.params.type as 'overall' | 'monthly' | 'custom';
      const phases = await getPhasesByType(type);
      return res.json({
        success: true,
        data: phases,
        count: phases.length,
        filters: { type },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/gameweek/:gameweek
  async getPhaseByGameweek(req: Request, res: Response) {
    try {
      const gameweek = parseInt(req.params.gameweek);
      if (isNaN(gameweek)) {
        return res.status(400).json({ success: false, error: 'Invalid gameweek' });
      }

      const phase = await getPhaseByGameweek(gameweek);
      if (!phase) {
        return res.status(404).json({
          success: false,
          error: `No phase found for gameweek ${gameweek}`,
        });
      }

      return res.json({ success: true, data: phase, gameweek });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/scores
  async getPhasesWithScores(req: Request, res: Response) {
    try {
      const phases = await getPhasesWithHighestScores();
      const sortedPhases = sortPhasesByHighestScore(phases);
      return res.json({
        success: true,
        data: sortedPhases,
        count: sortedPhases.length,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // GET /phases/top-scoring
  async getTopScoringPhase(req: Request, res: Response) {
    try {
      const phase = await getTopScoringPhase();
      if (!phase) {
        return res.status(404).json({
          success: false,
          error: 'No phase with recorded scores found',
        });
      }

      return res.json({ success: true, data: phase });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // POST /phases/sync
  async syncPhases(req: Request, res: Response) {
    try {
      await syncPhases();
      return res.json({
        success: true,
        message: 'Phases synced successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },

  // DELETE /phases/cache
  async clearCache(req: Request, res: Response) {
    try {
      await clearPhasesCache();
      return res.json({
        success: true,
        message: 'Phases cache cleared',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const status = getErrorStatus(error);
      return res.status(status).json({ success: false, error: message });
    }
  },
};
