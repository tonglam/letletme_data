import { APIError, createInternalServerError } from '@infrastructure/errors';
import {
  BootstrapStrategy,
  Player,
  PlayerResponse,
  PlayerStat,
  PlayerValue,
  transformPlayerResponse,
} from '@types/players.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerCache } from './cache';
import { CacheInvalidation } from './cache/invalidation';
import { PlayerRepository } from './repository';

export const createPlayerOperations = (
  repository: PlayerRepository,
  cache: PlayerCache,
  cacheInvalidation: CacheInvalidation,
) => {
  // Core processing functions
  const processPlayers = (data: ReadonlyArray<PlayerResponse>): TE.TaskEither<APIError, void> =>
    pipe(
      data,
      TE.traverseArray((response) => pipe(transformPlayerResponse(response), TE.fromEither)),
      TE.chain((players) => repository.upsertMany(players)),
      TE.chain(() => cacheInvalidation.invalidateAll()),
      TE.mapLeft((error) => createInternalServerError({ message: error.message })),
    );

  const processValues = (
    data: ReadonlyArray<PlayerValue>,
    eventId: number,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      data,
      TE.traverseArray((value) => repository.upsertValue(value)),
      TE.chain(() => cacheInvalidation.invalidateAll()),
      TE.mapLeft((error) => createInternalServerError({ message: error.message })),
    );

  const processStats = (
    data: ReadonlyArray<PlayerStat>,
    eventId: number,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      data,
      TE.traverseArray((stats) => repository.upsertStats(stats)),
      TE.chain(() => cacheInvalidation.invalidateAll()),
      TE.mapLeft((error) => createInternalServerError({ message: error.message })),
    );

  // Strategy selector
  const processBootstrapData = (
    strategy: BootstrapStrategy,
    data: ReadonlyArray<PlayerResponse>,
    eventId: number,
  ): TE.TaskEither<APIError, void> => {
    const strategies: Record<BootstrapStrategy, TE.TaskEither<APIError, void>> = {
      players: processPlayers(data),
      values: pipe(
        processPlayers(data),
        TE.chain(() => processValues([], eventId)), // TODO: Transform values data
      ),
      stats: pipe(
        processPlayers(data),
        TE.chain(() => processStats([], eventId)), // TODO: Transform stats data
      ),
      all: pipe(
        processPlayers(data),
        TE.chain(() => processValues([], eventId)),
        TE.chain(() => processStats([], eventId)),
      ),
    };

    return strategies[strategy];
  };

  // Query operations
  const getAll = (): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      cache.getPlayers(),
      TE.orElse(() =>
        pipe(
          repository.findAll(),
          TE.chain((players) =>
            pipe(
              cache.setPlayers(players),
              TE.map(() => players),
            ),
          ),
        ),
      ),
    );

  const getById = (id: number): TE.TaskEither<APIError, Player> =>
    pipe(
      cache.getPlayer(id),
      TE.orElse(() =>
        pipe(
          repository.findById(id),
          TE.chain((player) =>
            pipe(
              cache.setPlayer(id, player),
              TE.map(() => player),
            ),
          ),
        ),
      ),
    );

  const getPlayerValues = (id: number): TE.TaskEither<APIError, ReadonlyArray<PlayerValue>> =>
    pipe(
      cache.getPlayerValues(id),
      TE.orElse(() =>
        pipe(
          repository.findValuesByPlayerId(id),
          TE.chain((values) =>
            pipe(
              cache.setPlayerValues(id, values),
              TE.map(() => values),
            ),
          ),
        ),
      ),
    );

  const getPlayerStats = (id: number): TE.TaskEither<APIError, ReadonlyArray<PlayerStat>> =>
    pipe(
      cache.getPlayerStats(id),
      TE.orElse(() =>
        pipe(
          repository.findStatsByPlayerId(id),
          TE.chain((stats) =>
            pipe(
              cache.setPlayerStats(id, stats),
              TE.map(() => stats),
            ),
          ),
        ),
      ),
    );

  return {
    processBootstrapData,
    getAll,
    getById,
    getPlayerValues,
    getPlayerStats,
  } as const;
};

export type PlayerOperations = ReturnType<typeof createPlayerOperations>;
