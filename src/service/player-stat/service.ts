// Player Stat Service Module
// Provides business logic for Player Stat operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { EventOperations } from '../../domain/event/types';
import { createPlayerStatOperations } from '../../domain/player-stat/operation';
import { PlayerStatCache, PlayerStatOperations } from '../../domain/player-stat/types';
import { ElementResponse } from '../../types/element.type';
import { APIError, ServiceError } from '../../types/error.type';
import {
  PlayerStat,
  PlayerStatId,
  PlayerStatRepository,
  PlayerStats,
  toDomainPlayerStat,
} from '../../types/player-stat.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  PlayerStatService,
  PlayerStatServiceDependencies,
  PlayerStatServiceOperations,
  PlayerStatServiceWithWorkflows,
} from './types';
import { playerStatWorkflows } from './workflow';

// Implementation of service operations
const playerStatServiceOperations = (
  domainOps: PlayerStatOperations,
): PlayerStatServiceOperations => ({
  findAllPlayerStats: () =>
    pipe(domainOps.getAllPlayerStats(), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      PlayerStats
    >,

  findPlayerStatById: (id: PlayerStatId) =>
    pipe(domainOps.getPlayerStatById(id), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      PlayerStat | null
    >,

  syncPlayerStatsFromApi: (bootstrapApi: PlayerStatServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapElements(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch player stats from API',
          cause: error,
        }),
      ),
      TE.chain((elements: readonly ElementResponse[]) =>
        pipe(
          TE.right(elements.map((element) => toDomainPlayerStat(element, 0))),
          TE.chain((domainStats) =>
            pipe(
              domainOps.deleteAll(),
              TE.mapLeft(mapDomainError),
              TE.chain(() =>
                pipe(domainOps.createPlayerStats(domainStats), TE.mapLeft(mapDomainError)),
              ),
            ),
          ),
        ),
      ),
    ) as TE.TaskEither<ServiceError, PlayerStats>,
});

export const createPlayerStatService = (
  bootstrapApi: PlayerStatServiceDependencies['bootstrapApi'],
  repository: PlayerStatRepository,
  eventOperations: EventOperations,
  cache: PlayerStatCache = {
    warmUp: () => TE.right(undefined),
    cachePlayerStat: () => TE.right(undefined),
    cachePlayerStats: () => TE.right(undefined),
    getPlayerStat: () => TE.right(null),
    getAllPlayerStats: () => TE.right([]),
  },
): PlayerStatServiceWithWorkflows => {
  const domainOps = createPlayerStatOperations(repository, cache, eventOperations);
  const ops = playerStatServiceOperations(domainOps);

  const service: PlayerStatService = {
    getPlayerStats: () => ops.findAllPlayerStats(),
    getPlayerStat: (id: PlayerStatId) => ops.findPlayerStatById(id),
    savePlayerStats: (stats: PlayerStats) =>
      pipe(domainOps.createPlayerStats(stats), TE.mapLeft(mapDomainError)),
    syncPlayerStatsFromApi: () => ops.syncPlayerStatsFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: playerStatWorkflows(service),
  };
};
