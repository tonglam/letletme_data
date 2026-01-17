import { playersCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { playerRepository } from '../repositories/players';
import { transformPlayers } from '../transformers/players';
import { logError, logInfo } from '../utils/logger';

/**
 * Players Service - Business Logic Layer
 *
 * Handles all player-related operations:
 * - Data synchronization from FPL API
 * - Database operations
 */

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

    if (fplData.elements.length === 0) {
      throw new Error('No players returned from FPL API');
    }

    // 2. Transform and validate the data
    const transformedPlayers = transformPlayers(fplData.elements);
    if (transformedPlayers.length === 0) {
      throw new Error('No valid players were transformed');
    }
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
