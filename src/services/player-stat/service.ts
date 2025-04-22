import { EventCache } from 'domains/event/types';
import { PlayerCache } from 'domains/player/types';
import { createPlayerStatOperations } from 'domains/player-stat/operation';
import { PlayerStatCache, PlayerStatOperations } from 'domains/player-stat/types';
import { TeamCache } from 'domains/team/types';
import { pipe, flow } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatService, PlayerStatServiceOperations } from 'services/player-stat/types';
import { FplBootstrapDataService } from 'src/data/types';
import { PlayerStatRepository } from 'src/repositories/player-stat/type';
import { PlayerStat, PlayerStats } from 'src/types/domain/player-stat.type';
import {
  DataLayerError,
  DomainErrorCode,
  ServiceError,
  ServiceErrorCode,
  createDomainError,
  createServiceError,
} from 'src/types/error.type';
import { enrichPlayerStat, enrichPlayerStats } from 'src/utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

const playerStatServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerStatOperations,
  playerStatCache: PlayerStatCache,
  eventCache: EventCache,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerStatServiceOperations => ({
  findPlayerStat: (element: number): TE.TaskEither<ServiceError, PlayerStat> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Player stat with element ${element} not found in cache.`,
          }),
        ),
      )((sourceStats) => O.fromNullable(sourceStats.find((stat) => stat.element === element))),
      TE.chainW(
        flow(enrichPlayerStat(playerCache, teamCache), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.map((enrichedStat) => enrichedStat as PlayerStat),
    ),

  findPlayerStatsByElementType: (elementType: number): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainW(
        flow(enrichPlayerStats(playerCache, teamCache), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.map((enrichedPlayerStats: PlayerStats) =>
        enrichedPlayerStats.filter((playerStat) => playerStat.elementType === elementType),
      ),
      TE.map((filteredStats) => filteredStats as PlayerStats),
    ),

  findPlayerStatsByTeam: (team: number): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainW(
        flow(enrichPlayerStats(playerCache, teamCache), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.map((enrichedPlayerStats: PlayerStats) =>
        enrichedPlayerStats.filter((playerStat) => playerStat.team === team),
      ),
      TE.map((filteredStats) => filteredStats as PlayerStats),
    ),

  findLatestPlayerStats: (): TE.TaskEither<ServiceError, PlayerStats> =>
    pipe(
      playerStatCache.getLatestPlayerStats(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainW(
        flow(enrichPlayerStats(playerCache, teamCache), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.map((enrichedStats) => enrichedStats as PlayerStats),
    ),

  syncPlayerStatsFromApi: (): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventCache.getCurrentEvent(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chain((event) =>
        event
          ? pipe(
              fplDataService.getPlayerStats(event.id),
              TE.mapLeft((error: DataLayerError) =>
                createServiceIntegrationError({
                  message: 'Failed to fetch player stats via data layer',
                  cause: error.cause,
                }),
              ),
              TE.chainFirstW(() =>
                pipe(domainOps.deleteLatestPlayerStats(), TE.mapLeft(mapDomainErrorToServiceError)),
              ),
              TE.chainW((sourcePlayerStats) =>
                pipe(
                  domainOps.saveLatestPlayerStats(sourcePlayerStats),
                  TE.mapLeft(mapDomainErrorToServiceError),
                  TE.chainW(() =>
                    pipe(
                      playerStatCache.setLatestPlayerStats(sourcePlayerStats),
                      TE.mapLeft(mapDomainErrorToServiceError),
                    ),
                  ),
                  TE.map(() => undefined),
                ),
              ),
            )
          : TE.left(
              createServiceError({
                code: ServiceErrorCode.OPERATION_ERROR,
                message: 'No current event found to sync player stats for.',
              }),
            ),
      ),
    ),
});

export const createPlayerStatService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerStatRepository,
  playerStatCache: PlayerStatCache,
  eventCache: EventCache,
  playerCache: PlayerCache,
  teamCache: TeamCache,
): PlayerStatService => {
  const domainOps = createPlayerStatOperations(repository);
  const ops = playerStatServiceOperations(
    fplDataService,
    domainOps,
    playerStatCache,
    eventCache,
    playerCache,
    teamCache,
  );

  return {
    getPlayerStat: (element: number): TE.TaskEither<ServiceError, PlayerStat> =>
      ops.findPlayerStat(element),
    getPlayerStatsByElementType: (elementType: number): TE.TaskEither<ServiceError, PlayerStats> =>
      ops.findPlayerStatsByElementType(elementType),
    getPlayerStatsByTeam: (team: number): TE.TaskEither<ServiceError, PlayerStats> =>
      ops.findPlayerStatsByTeam(team),
    getLatestPlayerStats: (): TE.TaskEither<ServiceError, PlayerStats> =>
      ops.findLatestPlayerStats(),
    syncPlayerStatsFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPlayerStatsFromApi(),
  };
};
