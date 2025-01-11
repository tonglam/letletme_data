// Player Service Module
// Provides business logic for Player operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as A from 'fp-ts/Array';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createPlayerOperations } from '../../domain/player/operation';
import { PlayerCache, PlayerOperations } from '../../domain/player/types';
import { ElementTypeConfig } from '../../types/base.type';
import { ElementResponse } from '../../types/element.type';
import { APIError, ServiceError } from '../../types/error.type';
import {
  Player,
  PlayerId,
  PlayerRepository,
  Players,
  toDomainPlayer,
} from '../../types/player.type';
import { Team } from '../../types/team.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  EnhancedPlayer,
  EnhancedPlayers,
  PlayerService,
  PlayerServiceDependencies,
  PlayerServiceOperations,
  PlayerServiceWithWorkflows,
} from './types';
import { playerWorkflows } from './workflow';

const enhancePlayer = (player: Player, team: Team): EnhancedPlayer => ({
  id: player.id,
  elementCode: player.elementCode,
  price: player.price,
  startPrice: player.startPrice,
  elementType: ElementTypeConfig[player.elementType].name,
  firstName: player.firstName,
  secondName: player.secondName,
  webName: player.webName,
  team: {
    id: team.id,
    name: team.name,
    shortName: team.shortName,
  },
});

const enhancePlayers = (
  players: Players,
  teamService: PlayerServiceDependencies['teamService'],
): TE.TaskEither<ServiceError, EnhancedPlayers> =>
  pipe(
    // 1. Get unique team IDs
    [...players].reduce((acc, p) => acc.add(p.teamId), new Set<number>()),
    Array.from,
    // 2. Load all teams in parallel
    A.traverse(TE.ApplicativePar)((teamId: number) => teamService.getTeam(teamId)),
    // 3. Create team lookup map
    TE.map((teams) =>
      teams.reduce((acc, team) => {
        if (team) acc.set(team.id, team);
        return acc;
      }, new Map<number, Team>()),
    ),
    // 4. Transform players using team map
    TE.chain((teamMap) =>
      pipe(
        [...players],
        A.traverse(TE.ApplicativePar)((player) => {
          const team = teamMap.get(player.teamId);
          return team
            ? TE.right(enhancePlayer(player, team))
            : TE.left(
                createServiceIntegrationError({
                  message: `Team not found for player ${player.id}`,
                }),
              );
        }),
      ),
    ),
  );

const playerServiceOperations = (
  domainOps: PlayerOperations,
  dependencies: PlayerServiceDependencies,
): PlayerServiceOperations => ({
  findAllPlayers: () =>
    pipe(
      domainOps.getAllPlayers(),
      TE.mapLeft(mapDomainError),
      TE.chain((players) => enhancePlayers(players, dependencies.teamService)),
    ),

  findPlayerById: (id: PlayerId) =>
    pipe(
      domainOps.getPlayerById(id),
      TE.mapLeft(mapDomainError),
      TE.chain((player) =>
        player
          ? pipe(
              dependencies.teamService.getTeam(player.teamId),
              TE.chain((team) =>
                team
                  ? TE.right(enhancePlayer(player, team))
                  : TE.left(
                      createServiceIntegrationError({
                        message: `Team not found for player ${player.id}`,
                      }),
                    ),
              ),
            )
          : TE.right(null),
      ),
    ),

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
              domainOps.deleteAll(),
              TE.mapLeft(mapDomainError),
              TE.chain(() =>
                pipe(domainOps.createPlayers(domainPlayers), TE.mapLeft(mapDomainError)),
              ),
            ),
          ),
        ),
      ),
    ) as TE.TaskEither<ServiceError, Players>,
});

export const createPlayerService = (
  bootstrapApi: PlayerServiceDependencies['bootstrapApi'],
  repository: PlayerRepository,
  dependencies: PlayerServiceDependencies,
  cache: PlayerCache = {
    getAllPlayers: () => TE.right([]),
    getPlayer: () => TE.right(null),
    warmUp: () => TE.right(undefined),
    cachePlayer: () => TE.right(undefined),
    cachePlayers: () => TE.right(undefined),
  },
): PlayerServiceWithWorkflows => {
  const domainOps = createPlayerOperations(repository, cache);
  const ops = playerServiceOperations(domainOps, dependencies);

  const service: PlayerService = {
    getPlayers: () => ops.findAllPlayers(),
    getPlayer: (id: PlayerId) => pipe(domainOps.getPlayerById(id), TE.mapLeft(mapDomainError)),
    findPlayerById: (id: PlayerId) => ops.findPlayerById(id),
    savePlayers: (players: Players) =>
      pipe(domainOps.createPlayers(players), TE.mapLeft(mapDomainError)),
    syncPlayersFromApi: () => ops.syncPlayersFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: playerWorkflows(service),
  };
};
