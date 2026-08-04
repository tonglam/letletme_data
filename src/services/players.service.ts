import { playersCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { playerRepository } from '../repositories/players';
import { transformPlayersStrict } from '../transformers/players';
import { logError, logInfo } from '../utils/logger';
import { resolvePublishedSeasonFromEvents } from './cache-season.service';

import type { FPLBootstrapResponse } from '../clients/fpl';
import type { Player } from '../types';

/**
 * Players Service - Business Logic Layer
 *
 * Handles all player-related operations:
 * - Data synchronization from FPL API
 * - Database operations
 */

type PlayersBootstrap = Pick<FPLBootstrapResponse, 'elements' | 'events'>;

export type PlayersSyncDependencies = {
  getBootstrap: () => Promise<PlayersBootstrap>;
  upsertPlayers: (players: Player[]) => Promise<Player[]>;
  setPlayersCache: (players: Player[], season?: string) => Promise<void>;
  resolvePublishedSeason: (events: FPLBootstrapResponse['events']) => Promise<string | undefined>;
};

const defaultDependencies: PlayersSyncDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  upsertPlayers: playerRepository.upsertBatch,
  setPlayersCache: playersCache.set,
  resolvePublishedSeason: resolvePublishedSeasonFromEvents,
};

function assertUniquePlayerIds(players: readonly Player[], source: string): void {
  const ids = new Set<number>();
  for (const player of players) {
    if (ids.has(player.id)) {
      throw new Error(`${source} contains duplicate player ID ${player.id}`);
    }
    ids.add(player.id);
  }
}

function assertPersistedRosterMatches(
  expected: readonly Player[],
  persisted: readonly Player[],
): void {
  assertUniquePlayerIds(expected, 'Transformed player roster');
  assertUniquePlayerIds(persisted, 'Persisted player roster');

  const persistedById = new Map(persisted.map((player) => [player.id, player]));
  const fields = [
    'code',
    'type',
    'teamId',
    'price',
    'startPrice',
    'firstName',
    'secondName',
    'webName',
  ] as const satisfies readonly (keyof Player)[];

  if (persistedById.size !== expected.length) {
    throw new Error(
      `Player persistence returned an incomplete roster: ${persistedById.size}/${expected.length}`,
    );
  }

  for (const player of expected) {
    const persistedPlayer = persistedById.get(player.id);
    if (!persistedPlayer || fields.some((field) => persistedPlayer[field] !== player[field])) {
      throw new Error(`Player persistence verification failed for player ${player.id}`);
    }
  }
}

export function createPlayersSync(dependencies: PlayersSyncDependencies) {
  return async function syncPlayers(): Promise<{ count: number; errors: number }> {
    try {
      logInfo('Starting players sync from FPL API');

      // 1. Fetch data from FPL API
      const fplData = await dependencies.getBootstrap();

      if (!fplData.elements || !Array.isArray(fplData.elements)) {
        throw new Error('Invalid players data from FPL API');
      }

      logInfo('Raw players data fetched', { count: fplData.elements.length });

      if (fplData.elements.length === 0) {
        logInfo('No players returned from FPL API; preserving existing players cache');
        return { count: 0, errors: 0 };
      }

      // 2. Transform the complete roster. A single invalid or duplicate element
      // must preserve the previously published identity baseline.
      const transformedPlayers = transformPlayersStrict(fplData.elements);
      assertUniquePlayerIds(transformedPlayers, 'FPL player roster');
      logInfo('Players transformed', {
        total: fplData.elements.length,
        successful: transformedPlayers.length,
        errors: 0,
      });

      // 3. Batch upsert to database and verify every row before publication.
      const upsertedPlayers = await dependencies.upsertPlayers(transformedPlayers);
      assertPersistedRosterMatches(transformedPlayers, upsertedPlayers);
      logInfo('Players upserted to database', { count: upsertedPlayers.length });

      // 4. Atomically replace the shared Redis roster only after database
      // verification succeeds. Live snapshot workers read this shared truth on
      // every producer cycle, so no process-local invalidation is required.
      await dependencies.setPlayersCache(
        upsertedPlayers,
        await dependencies.resolvePublishedSeason(fplData.events),
      );
      logInfo('Players cache updated');

      const result = {
        count: upsertedPlayers.length,
        errors: 0,
      };

      logInfo('Players sync completed', result);
      return result;
    } catch (error) {
      logError('Players sync failed', error);
      throw error;
    }
  };
}

// Sync players from FPL API
export const syncPlayers = createPlayersSync(defaultDependencies);
