import { playersCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { playerRepository } from '../repositories/players';
import { transformPlayers } from '../transformers/players';
import type { Player } from '../types';
import { logError, logInfo } from '../utils/logger';

/**
 * Players Service - Business Logic Layer
 *
 * Handles all player-related operations:
 * - Data synchronization from FPL API
 * - Cache management
 * - Database operations
 * - Data retrieval with fallbacks and filtering
 */

// Get all players (cache-first strategy: Redis → DB → update Redis)
export async function getPlayers(): Promise<Player[]> {
  try {
    logInfo('Getting all players');

    // 1. Try cache first (fast path)
    const cached = await playersCache.get();
    if (cached) {
      logInfo('Players retrieved from cache', { count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database');
    const dbPlayers = await playerRepository.findAll();

    // 3. Update cache for next time (async, don't block response)
    if (dbPlayers.length > 0) {
      playersCache.set(dbPlayers).catch((error) => {
        logError('Failed to update players cache', error);
      });
    }

    logInfo('Players retrieved from database', { count: dbPlayers.length });
    return dbPlayers;
  } catch (error) {
    logError('Failed to get players', error);
    throw error;
  }
}

// Get single player by ID (cache-first strategy: Redis → DB → update Redis)
export async function getPlayer(id: number): Promise<Player | null> {
  try {
    logInfo('Getting player by id', { id });

    // 1. Try cache first (fast path)
    const cached = await playersCache.getPlayer(id);
    if (cached) {
      logInfo('Player retrieved from cache', {
        id,
        name: `${cached.firstName} ${cached.secondName}`,
      });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { id });
    const player = await playerRepository.findById(id);

    if (player) {
      // 3. Update cache for next time (async, don't block response)
      playersCache.get().then((allPlayers) => {
        if (!allPlayers) {
          // If full cache doesn't exist, fetch all and cache
          playerRepository.findAll().then((dbPlayers) => {
            playersCache.set(dbPlayers).catch((error) => {
              logError('Failed to update players cache', error);
            });
          });
        }
      });

      logInfo('Player found in database', { id, name: `${player.firstName} ${player.secondName}` });
    } else {
      logInfo('Player not found', { id });
    }

    return player;
  } catch (error) {
    logError('Failed to get player', error, { id });
    throw error;
  }
}

// Get players by team (cache-first strategy: Redis → DB → update Redis)
export async function getPlayersByTeam(teamId: number): Promise<Player[]> {
  try {
    logInfo('Getting players by team', { teamId });

    // 1. Try cache first (fast path - filters in-memory)
    const cached = await playersCache.getPlayersByTeam(teamId);
    if (cached) {
      logInfo('Players retrieved from cache (filtered by team)', { teamId, count: cached.length });
      return cached;
    }

    // 2. Cache miss - fallback to database
    logInfo('Cache miss - fetching from database', { teamId });
    const players = await playerRepository.findByTeam(teamId);

    // 3. Update cache for next time (async, don't block response)
    playersCache.get().then((allPlayers) => {
      if (!allPlayers) {
        // If full cache doesn't exist, fetch all and cache
        playerRepository.findAll().then((dbPlayers) => {
          playersCache.set(dbPlayers).catch((error) => {
            logError('Failed to update players cache', error);
          });
        });
      }
    });

    logInfo('Players retrieved from database by team', { teamId, count: players.length });
    return players;
  } catch (error) {
    logError('Failed to get players by team', error, { teamId });
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
