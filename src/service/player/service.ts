// Player Service Module
// Provides business logic for Player operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createPlayerOperations } from '../../domain/player/operation';
import { PlayerCache, PlayerOperations } from '../../domain/player/types';
import { ElementResponse } from '../../types/element.type';
import { APIError, ServiceError } from '../../types/error.type';
import {
  Player,
  PlayerId,
  PlayerRepository,
  Players,
  toDomainPlayer,
} from '../../types/player.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  PlayerService,
  PlayerServiceDependencies,
  PlayerServiceOperations,
  PlayerServiceWithWorkflows,
} from './types';
import { playerWorkflows } from './workflow';

// Implementation of service operations
const playerServiceOperations = (domainOps: PlayerOperations): PlayerServiceOperations => ({
  findAllPlayers: () =>
    pipe(domainOps.getAllPlayers(), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Players
    >,

  findPlayerById: (id: PlayerId) =>
    pipe(domainOps.getPlayerById(id), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Player | null
    >,

  syncPlayersFromApi: (bootstrapApi: PlayerServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapElements(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch players from API',
          cause: error,
        }),
      ),
      TE.chain((players: readonly ElementResponse[]) => {
        const domainResults = players.map((player) => {
          try {
            return E.right(toDomainPlayer(player));
          } catch (error) {
            return E.left(error instanceof Error ? error : new Error(String(error)));
          }
        });
        const validPlayers = domainResults.filter(E.isRight).map((result) => result.right);
        return pipe(
          domainOps.deleteAll(),
          TE.mapLeft(mapDomainError),
          TE.chain(() => pipe(domainOps.createPlayers(validPlayers), TE.mapLeft(mapDomainError))),
        );
      }),
    ) as TE.TaskEither<ServiceError, Players>,
});

export const createPlayerService = (
  bootstrapApi: PlayerServiceDependencies['bootstrapApi'],
  repository: PlayerRepository,
  cache: PlayerCache = {
    getAllPlayers: () => TE.right([]),
    getPlayer: () => TE.right(null),
    warmUp: () => TE.right(undefined),
    cachePlayer: () => TE.right(undefined),
    cachePlayers: () => TE.right(undefined),
  },
): PlayerServiceWithWorkflows => {
  const domainOps = createPlayerOperations(repository, cache);
  const ops = playerServiceOperations(domainOps);

  const service: PlayerService = {
    getPlayers: () => ops.findAllPlayers(),
    getPlayer: (id: PlayerId) => ops.findPlayerById(id),
    savePlayers: (players: Players) =>
      pipe(domainOps.createPlayers(players), TE.mapLeft(mapDomainError)),
    syncPlayersFromApi: () => ops.syncPlayersFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: playerWorkflows(service),
  };
};
