import { playersCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import {
  filterPlayersByPosition,
  filterPlayersByPriceRange,
  getBudgetPlayersByPosition,
  getFormRating,
  getPlayerPosition,
  getPlayerValueRating,
  getPriceChange,
  getPriceChangeDirection,
  getTopPlayersByPosition,
  hasInjuryConcerns,
  isBudgetPlayer,
  isDifferentialPlayer,
  isPlayerAvailable,
  isPremiumPlayer,
  isTemplatePlayer,
  type PlayerPosition,
} from '../domain/players';
import { playerRepository } from '../repositories/players';
import { transformPlayers } from '../transformers/players';
import { getErrorMessage, getErrorStatus, ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Request, Response } from 'express';
import type { Player } from '../types';

/**
 * Players Service - FPL Player Data Management
 *
 * Flow: FPL API → Transform → Database → Cache → HTTP Response
 */

// Get all players (with cache fallback)
export async function getPlayers(): Promise<Player[]> {
  try {
    logInfo('Getting all players');

    // 1. Try cache first (fast path)
    const cached = await playersCache.get();
    if (cached) {
      logInfo('Players retrieved from cache', { count: Array.isArray(cached) ? cached.length : 0 });
      return cached as Player[];
    }

    // 2. Fallback to database (slower path)
    const dbPlayers = await playerRepository.findAll();

    // 3. Update cache for next time
    if (dbPlayers.length > 0) {
      await playersCache.set(dbPlayers);
    }

    logInfo('Players retrieved from database', { count: dbPlayers.length });
    return dbPlayers;
  } catch (error) {
    logError('Failed to get players', error);
    throw error;
  }
}

// Get single player by ID
export async function getPlayer(id: number): Promise<Player | null> {
  try {
    logInfo('Getting player by id', { id });

    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError('Invalid player ID', 'INVALID_ID');
    }

    const player = await playerRepository.findById(id);

    if (player) {
      logInfo('Player found', { id, name: `${player.firstName} ${player.secondName}` });
    } else {
      logInfo('Player not found', { id });
    }

    return player;
  } catch (error) {
    logError('Failed to get player', error, { id });
    throw error;
  }
}

// Get players by team
export async function getPlayersByTeam(teamId: number): Promise<Player[]> {
  try {
    logInfo('Getting players by team', { teamId });

    if (!Number.isInteger(teamId) || teamId <= 0) {
      throw new ValidationError('Invalid team ID', 'INVALID_TEAM_ID');
    }

    const players = await playerRepository.findByTeam(teamId);
    logInfo('Players retrieved by team', { teamId, count: players.length });

    return players;
  } catch (error) {
    logError('Failed to get players by team', error, { teamId });
    throw error;
  }
}

// Get players by position
export async function getPlayersByPosition(position: PlayerPosition): Promise<Player[]> {
  try {
    logInfo('Getting players by position', { position });

    const allPlayers = await getPlayers();
    const filteredPlayers = filterPlayersByPosition(allPlayers, position);

    logInfo('Players filtered by position', { position, count: filteredPlayers.length });
    return filteredPlayers;
  } catch (error) {
    logError('Failed to get players by position', error, { position });
    throw error;
  }
}

// Get players with enhanced metadata and analytics
export async function getPlayersWithMetadata(): Promise<
  Array<
    Player & {
      position: PlayerPosition;
      isAvailable: boolean;
      isPremium: boolean;
      isBudget: boolean;
      isDifferential: boolean;
      isTemplate: boolean;
      formRating: string;
      valueRating: string;
      priceChange: number;
      priceChangeDirection: string;
      hasInjuryConcerns: boolean;
    }
  >
> {
  try {
    logInfo('Getting players with enhanced metadata');

    const players = await getPlayers();

    // This would ideally use enhanced player data from the cache/database
    // For now, we'll use the basic player data with computed metadata
    const enhancedPlayers = players.map((player) => ({
      ...player,
      position: getPlayerPosition(player.type),
      isAvailable: isPlayerAvailable({}), // Would need more data from FPL API
      isPremium: isPremiumPlayer(player),
      isBudget: isBudgetPlayer(player),
      isDifferential: isDifferentialPlayer({}), // Would need ownership data
      isTemplate: isTemplatePlayer({}), // Would need ownership data
      formRating: getFormRating({}), // Would need form data
      valueRating: getPlayerValueRating(player), // Would need points data
      priceChange: getPriceChange(player),
      priceChangeDirection: getPriceChangeDirection(player),
      hasInjuryConcerns: hasInjuryConcerns({}), // Would need status/news data
    }));

    logInfo('Players metadata computed', { count: enhancedPlayers.length });
    return enhancedPlayers;
  } catch (error) {
    logError('Failed to get players with metadata', error);
    throw error;
  }
}

// Get top players by position and price
export async function getTopPlayersByPositionAndPrice(
  position: PlayerPosition,
  limit: number = 10,
): Promise<Player[]> {
  try {
    logInfo('Getting top players by position', { position, limit });

    const allPlayers = await getPlayers();
    const topPlayers = getTopPlayersByPosition(allPlayers, position, limit);

    logInfo('Top players retrieved', { position, count: topPlayers.length });
    return topPlayers;
  } catch (error) {
    logError('Failed to get top players', error, { position, limit });
    throw error;
  }
}

// Get budget players by position
export async function getBudgetPlayers(
  position: PlayerPosition,
  limit: number = 10,
): Promise<Player[]> {
  try {
    logInfo('Getting budget players by position', { position, limit });

    const allPlayers = await getPlayers();
    const budgetPlayers = getBudgetPlayersByPosition(allPlayers, position, limit);

    logInfo('Budget players retrieved', { position, count: budgetPlayers.length });
    return budgetPlayers;
  } catch (error) {
    logError('Failed to get budget players', error, { position, limit });
    throw error;
  }
}

// Get players by price range
export async function getPlayersByPriceRange(
  minPrice: number,
  maxPrice: number,
): Promise<Player[]> {
  try {
    logInfo('Getting players by price range', { minPrice, maxPrice });

    if (
      !Number.isFinite(minPrice) ||
      !Number.isFinite(maxPrice) ||
      minPrice < 0 ||
      maxPrice < minPrice
    ) {
      throw new ValidationError('Invalid price range', 'INVALID_PRICE_RANGE');
    }

    const allPlayers = await getPlayers();
    const filteredPlayers = filterPlayersByPriceRange(allPlayers, minPrice, maxPrice);

    logInfo('Players filtered by price range', {
      minPrice,
      maxPrice,
      count: filteredPlayers.length,
    });
    return filteredPlayers;
  } catch (error) {
    logError('Failed to get players by price range', error, { minPrice, maxPrice });
    throw error;
  }
}

// Sync players from FPL API
export async function syncPlayers(): Promise<{ count: number; errors: number }> {
  try {
    logInfo('Starting players sync from FPL API');

    // 1. Fetch data from FPL API
    const fplData = await fplClient.getBootstrap();

    if (!fplData.elements || !Array.isArray(fplData.elements)) {
      throw new Error('Invalid players data from FPL API');
    }

    logInfo('Raw players data fetched', { count: fplData.elements.length });

    // 2. Transform and validate the data
    const transformedPlayers = transformPlayers(fplData.elements);
    logInfo('Players transformed', {
      total: fplData.elements.length,
      successful: transformedPlayers.length,
      errors: fplData.elements.length - transformedPlayers.length,
    });

    // 3. Batch upsert to database
    const upsertedPlayers = await playerRepository.upsertBatch(transformedPlayers);
    logInfo('Players upserted to database', { count: upsertedPlayers.length });

    // 4. Update cache with fresh data
    await playersCache.set(upsertedPlayers);
    logInfo('Players cache updated');

    const result = {
      count: upsertedPlayers.length,
      errors: fplData.elements.length - transformedPlayers.length,
    };

    logInfo('Players sync completed', result);
    return result;
  } catch (error) {
    logError('Players sync failed', error);
    throw error;
  }
}

// Clear players cache
export async function clearPlayersCache(): Promise<void> {
  try {
    logInfo('Clearing players cache');
    await playersCache.clear();
    logInfo('Players cache cleared');
  } catch (error) {
    logError('Failed to clear players cache', error);
    throw error;
  }
}

// Get players cache status
export async function getPlayersCacheStatus(): Promise<{
  hasCache: boolean;
  count?: number;
  error?: string;
}> {
  try {
    const cached = await playersCache.get();
    return {
      hasCache: !!cached,
      count: Array.isArray(cached) ? cached.length : undefined,
    };
  } catch (error) {
    return {
      hasCache: false,
      error: getErrorMessage(error),
    };
  }
}

// ================================
// HTTP Route Handlers
// ================================

export async function handleGetPlayers(req: Request, res: Response): Promise<void> {
  try {
    const { position, team, minPrice, maxPrice, limit, metadata } = req.query;

    let players: Player[] | any[];

    // Get players with optional filters
    if (position && typeof position === 'string') {
      const validPosition = position.toUpperCase() as PlayerPosition;
      if (!['GKP', 'DEF', 'MID', 'FWD'].includes(validPosition)) {
        res.status(400).json({ error: 'Invalid position. Must be GKP, DEF, MID, or FWD' });
        return;
      }
      players = await getPlayersByPosition(validPosition);
    } else if (team && typeof team === 'string') {
      const teamId = parseInt(team, 10);
      if (Number.isNaN(teamId)) {
        res.status(400).json({ error: 'Invalid team ID' });
        return;
      }
      players = await getPlayersByTeam(teamId);
    } else if (minPrice && maxPrice) {
      const min = parseFloat(minPrice as string);
      const max = parseFloat(maxPrice as string);
      if (Number.isNaN(min) || Number.isNaN(max)) {
        res.status(400).json({ error: 'Invalid price range' });
        return;
      }
      players = await getPlayersByPriceRange(min * 10, max * 10); // Convert to API format
    } else {
      players = metadata === 'true' ? await getPlayersWithMetadata() : await getPlayers();
    }

    // Apply limit if specified
    if (limit && typeof limit === 'string') {
      const limitNum = parseInt(limit, 10);
      if (!Number.isNaN(limitNum) && limitNum > 0) {
        players = players.slice(0, limitNum);
      }
    }

    res.json({
      players,
      count: players.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('GET /players failed', error);
    res.status(getErrorStatus(error)).json({
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
}

export async function handleGetPlayer(req: Request, res: Response): Promise<void> {
  try {
    const playerId = parseInt(req.params.id, 10);

    if (Number.isNaN(playerId)) {
      res.status(400).json({ error: 'Invalid player ID' });
      return;
    }

    const player = await getPlayer(playerId);

    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    res.json({
      player,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('GET /players/:id failed', error);
    res.status(getErrorStatus(error)).json({
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
}

export async function handleSyncPlayers(req: Request, res: Response): Promise<void> {
  try {
    const result = await syncPlayers();

    res.json({
      message: 'Players sync completed',
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('POST /players/sync failed', error);
    res.status(getErrorStatus(error)).json({
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
}

export async function handleClearPlayersCache(req: Request, res: Response): Promise<void> {
  try {
    await clearPlayersCache();

    res.json({
      message: 'Players cache cleared successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('DELETE /players/cache failed', error);
    res.status(getErrorStatus(error)).json({
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
}

export async function handleGetPlayersCacheStatus(req: Request, res: Response): Promise<void> {
  try {
    const status = await getPlayersCacheStatus();

    res.json({
      cache: status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('GET /players/cache/status failed', error);
    res.status(getErrorStatus(error)).json({
      error: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });
  }
}
