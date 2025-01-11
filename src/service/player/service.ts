// Player Service Module
// Provides business logic for Player operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ElementResponse } from '../../types/element.type';
import { APIError, ServiceError } from '../../types/error.type';
import { PlayerId, Players, toDomainPlayer } from '../../types/player.type';
import { PlayerCommandOperations, PlayerQueryOperations } from '../../types/player/types';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  PlayerService,
  PlayerServiceDependencies,
  PlayerServiceOperations,
  PlayerServiceWithWorkflows,
} from './types';
import { playerWorkflows } from './workflow';

const playerServiceOperations = (
  queryOps: PlayerQueryOperations,
  commandOps: PlayerCommandOperations,
): PlayerServiceOperations => ({
  findAllPlayers: () => pipe(queryOps.getAllPlayersWithTeams(), TE.mapLeft(mapDomainError)),

  findPlayerById: (id: PlayerId) =>
    pipe(queryOps.getPlayerWithTeam(id), TE.mapLeft(mapDomainError)),

  syncPlayersFromApi: (bootstrapApi: PlayerServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapElements(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch players from API',
          cause: error,
        }),
      ),
      TE.chain((players: readonly ElementResponse[]) =>
        pipe(
          TE.right(players.map(toDomainPlayer)),
          TE.chain((domainPlayers) =>
            pipe(
              commandOps.deleteAll(),
              TE.mapLeft(mapDomainError),
              TE.chain(() =>
                pipe(commandOps.createPlayers(domainPlayers), TE.mapLeft(mapDomainError)),
              ),
            ),
          ),
        ),
      ),
    ) as TE.TaskEither<ServiceError, Players>,
});

export const createPlayerService = (
  bootstrapApi: PlayerServiceDependencies['bootstrapApi'],
  queryOps: PlayerQueryOperations,
  commandOps: PlayerCommandOperations,
): PlayerServiceWithWorkflows => {
  const ops = playerServiceOperations(queryOps, commandOps);

  const service: PlayerService = {
    getPlayers: () => ops.findAllPlayers(),
    getPlayer: (id: PlayerId) => pipe(commandOps.getPlayerById(id), TE.mapLeft(mapDomainError)),
    findPlayerById: (id: PlayerId) => ops.findPlayerById(id),
    savePlayers: (players: Players) =>
      pipe(commandOps.createPlayers(players), TE.mapLeft(mapDomainError)),
    syncPlayersFromApi: () => ops.syncPlayersFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: playerWorkflows(service),
  };
};
