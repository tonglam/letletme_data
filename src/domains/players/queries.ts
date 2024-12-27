import { ElementType } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../../infrastructure/http/common/errors';
import { PlayerStat } from '../../types/player-stats.type';
import { PlayerValue } from '../../types/player-values.type';
import {
  Player,
  PlayerId,
  PlayerRepository,
  Players,
  convertPrismaPlayer,
  convertPrismaPlayers,
} from '../../types/players.type';

/**
 * Retrieves a player's history between two event IDs
 * @param repository - The player repository instance
 * @param playerId - The player ID to find history for
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with array of player history or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getPlayerHistory = (
  repository: PlayerRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<APIError, Players> =>
  pipe(
    TE.sequenceArray(
      Array.from({ length: endEventId - startEventId + 1 }).map(() =>
        pipe(repository.findById(playerId), TE.chain(convertPrismaPlayer)),
      ),
    ),
    TE.map((players) => players.filter((p): p is Player => p !== null)),
  );

/**
 * Retrieves all players from a specific team
 * @param repository - The player repository instance
 * @param teamId - The team ID to find players for
 * @returns TaskEither with array of players or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getTeamPlayers = (
  repository: PlayerRepository,
  teamId: number,
): TE.TaskEither<APIError, Players> =>
  pipe(
    repository.findAll(),
    TE.chain(convertPrismaPlayers),
    TE.map((players) => players.filter((p) => p.teamId === teamId)),
  );

/**
 * Retrieves all players of a specific position/element type
 * @param repository - The player repository instance
 * @param elementType - The element type to filter by
 * @returns TaskEither with array of players or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getPlayersByPosition = (
  repository: PlayerRepository,
  elementType: ElementType,
): TE.TaskEither<APIError, Players> =>
  pipe(
    repository.findAll(),
    TE.chain(convertPrismaPlayers),
    TE.map((players) => players.filter((p) => p.elementType === elementType)),
  );

/**
 * Retrieves players sorted by their performance (BPS)
 * @param repository - The player repository instance
 * @param statsRepository - The player stats repository instance
 * @param limit - Maximum number of players to return
 * @returns TaskEither with array of top performing players or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getTopPerformers = (
  repository: PlayerRepository,
  statsRepository: { findById: (id: PlayerId) => TE.TaskEither<APIError, PlayerStat | null> },
  limit: number = 10,
): TE.TaskEither<APIError, Players> =>
  pipe(
    repository.findAll(),
    TE.chain(convertPrismaPlayers),
    TE.chain((players) =>
      TE.sequenceArray(
        players.map((p) =>
          pipe(
            statsRepository.findById(p.id),
            TE.map((stats) => ({ player: p, totalPoints: stats?.bps ?? 0 })),
          ),
        ),
      ),
    ),
    TE.map((playersWithStats) =>
      [...playersWithStats]
        .sort((a, b) => b.totalPoints - a.totalPoints)
        .slice(0, limit)
        .map((p) => p.player),
    ),
  );

/**
 * Retrieves players sorted by their market value
 * @param repository - The player repository instance
 * @param valueRepository - The player value repository instance
 * @param limit - Maximum number of players to return
 * @returns TaskEither with array of most valuable players or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getMostValuablePlayers = (
  repository: PlayerRepository,
  valueRepository: { findById: (id: PlayerId) => TE.TaskEither<APIError, PlayerValue | null> },
  limit: number = 10,
): TE.TaskEither<APIError, Players> =>
  pipe(
    repository.findAll(),
    TE.chain(convertPrismaPlayers),
    TE.chain((players) =>
      TE.sequenceArray(
        players.map((p) =>
          pipe(
            valueRepository.findById(p.id),
            TE.map((value) => ({ player: p, value: value?.value ?? p.price })),
          ),
        ),
      ),
    ),
    TE.map((playersWithValues) =>
      [...playersWithValues]
        .sort((a, b) => b.value - a.value)
        .slice(0, limit)
        .map((p) => p.player),
    ),
  );

/**
 * Searches for players by name
 * @param repository - The player repository instance
 * @param searchTerm - The search term to match against player names
 * @returns TaskEither with array of matching players or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getPlayersBySearchTerm = (
  repository: PlayerRepository,
  searchTerm: string,
): TE.TaskEither<APIError, Players> =>
  pipe(
    repository.findAll(),
    TE.chain(convertPrismaPlayers),
    TE.map((players) =>
      players.filter(
        (p) =>
          p.webName.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (p.firstName?.toLowerCase() ?? '').includes(searchTerm.toLowerCase()) ||
          (p.secondName?.toLowerCase() ?? '').includes(searchTerm.toLowerCase()),
      ),
    ),
  );
