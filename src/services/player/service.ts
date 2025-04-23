import { createPlayerOperations } from 'domains/player/operation';
import { PlayerCache, PlayerOperations } from 'domains/player/types';
import { TeamCache } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { FplBootstrapDataService } from 'src/data/types';
import { getLogger } from 'src/infrastructures/logger';
import { PlayerRepository } from 'src/repositories/player/type';
import { Player, PlayerId, Players, PlayerType, RawPlayers } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';
import {
  createDomainError,
  DataLayerError,
  DomainErrorCode,
  ServiceError,
} from 'src/types/error.type';
import { enrichPlayers } from 'src/utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

import { PlayerService, PlayerServiceOperations } from './types';

const logger = getLogger(__filename);

const playerServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerOperations,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerServiceOperations => {
  const findPlayerById = (id: PlayerId): TE.TaskEither<ServiceError, Player> =>
    pipe(
      playerCache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Player with ID ${id} not found in cache.`,
          }),
        ),
      )((players) => RA.findFirst((p: Player) => p.id === id)(players)),
    );

  const findPlayersByElementType = (
    elementType: PlayerType,
  ): TE.TaskEither<ServiceError, Players> =>
    pipe(
      playerCache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.type === elementType)(players)),
    );

  const findPlayersByTeam = (teamId: TeamId): TE.TaskEither<ServiceError, Players> =>
    pipe(
      playerCache.getAllPlayers(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((players) => RA.filter((p: Player) => p.teamId === teamId)(players)),
    );

  const findAllPlayers = (): TE.TaskEither<ServiceError, Players> =>
    pipe(playerCache.getAllPlayers(), TE.mapLeft(mapDomainErrorToServiceError));

  const syncPlayersFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      TE.Do,
      TE.tapIO(() => logger.info('Starting syncPlayersFromApi pipeline')),
      TE.bindW('rawPlayers', () =>
        pipe(
          fplDataService.getPlayers(),
          TE.mapLeft((error: DataLayerError) =>
            createServiceIntegrationError({
              message: 'Failed to fetch/map players via data layer',
              cause: error.cause,
              details: error.details,
            }),
          ),
          TE.tapIO((players) => logger.info(`Fetched ${players.length} raw players`)),
        ),
      ),
      TE.tapIO(() => logger.info('Attempting to delete all players...')),
      TE.chainFirstW(() =>
        pipe(domainOps.deleteAllPlayers(), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.tapIO(() => logger.info('Successfully deleted players.')),
      TE.tapIO(() => logger.info('Attempting to save players...')),
      TE.chainW(({ rawPlayers }) =>
        pipe(
          rawPlayers.length > 0
            ? domainOps.savePlayers(rawPlayers)
            : TE.right(rawPlayers as RawPlayers),
          TE.mapLeft(mapDomainErrorToServiceError),
          TE.tapIO((saved) => logger.info(`Successfully saved ${saved.length} players.`)),
        ),
      ),
      TE.tapIO(() => logger.info('Attempting to fetch and cache teams...')),
      TE.chainFirstW(() =>
        pipe(
          fplDataService.getTeams(),
          TE.mapLeft((error: DataLayerError) =>
            createServiceIntegrationError({
              message: 'Failed to fetch/map teams via data layer for enrichment',
              cause: error.cause,
              details: error.details,
            }),
          ),
          TE.chainW((teams) =>
            pipe(teamCache.setAllTeams(teams), TE.mapLeft(mapDomainErrorToServiceError)),
          ),
          TE.tapIO(() => logger.info('Successfully fetched and cached teams.')),
        ),
      ),
      TE.bindW('savedPlayers', ({ rawPlayers }) => TE.right(rawPlayers)),
      TE.tapIO(() => logger.info('Attempting to enrich players...')),
      TE.chainW(({ savedPlayers }) =>
        pipe(
          enrichPlayers(teamCache)(savedPlayers),
          TE.mapLeft(mapDomainErrorToServiceError),
          TE.tapIO((enriched) => logger.info(`Successfully enriched ${enriched.length} players.`)),
        ),
      ),
      TE.tapIO(() => logger.info('Attempting to cache enriched players...')),
      TE.chainW((enrichedPlayers) =>
        pipe(
          enrichedPlayers.length > 0
            ? playerCache.setAllPlayers(enrichedPlayers)
            : TE.rightIO(() => {}),
          TE.mapLeft(mapDomainErrorToServiceError),
          TE.tapIO(() => logger.info('Successfully cached enriched players.')),
        ),
      ),
      TE.map(() => void 0),
      TE.tapIO(() => logger.info('Finished syncPlayersFromApi pipeline successfully')),
      TE.orElseFirstIOK((err) => logger.error({ err }, 'syncPlayersFromApi pipeline failed')),
    );

  return {
    findPlayerById,
    findPlayersByElementType,
    findPlayersByTeam,
    findAllPlayers,
    syncPlayersFromApi,
  };
};

export const createPlayerService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerRepository,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerService => {
  const domainOps = createPlayerOperations(repository);
  const ops = playerServiceOperations(fplDataService, domainOps, playerCache, teamCache);

  return {
    getPlayer: (id: PlayerId): TE.TaskEither<ServiceError, Player> => ops.findPlayerById(id),
    getPlayersByElementType: (elementType: PlayerType): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayersByElementType(elementType),
    getPlayersByTeam: (teamId: TeamId): TE.TaskEither<ServiceError, Players> =>
      ops.findPlayersByTeam(teamId),
    getPlayers: (): TE.TaskEither<ServiceError, Players> => ops.findAllPlayers(),
    syncPlayersFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPlayersFromApi(),
  };
};
