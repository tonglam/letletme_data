import { createEventLiveOperations } from 'domain/event-live/operation';
import { EventLiveCache, EventLiveOperations } from 'domain/event-live/types';
import { PlayerCache } from 'domain/player/types';
import { TeamCache } from 'domain/team/types';

import { FplLiveDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as IO from 'fp-ts/IO';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { EventLiveRepository } from 'repository/event-live/types';
import { EventService } from 'service/event/types';
import { EventLiveService, EventLiveServiceOperations } from 'service/event-live/types';
import { EventLive, EventLives, RawEventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { createDomainError, DataLayerError, DomainErrorCode, ServiceError } from 'types/error.type';
import { enrichEventLives } from 'utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const eventLiveServiceOperations = (
  fplDataService: FplLiveDataService,
  domainOps: EventLiveOperations,
  cache: EventLiveCache,
  playerCache: PlayerCache,
  teamCache: TeamCache,
  eventService: EventService,
): EventLiveServiceOperations => {
  const findEventLives = (eventId: EventId): TE.TaskEither<ServiceError, EventLives> =>
    pipe(cache.getEventLives(eventId), TE.mapLeft(mapDomainErrorToServiceError));

  const findEventLiveByElementId = (
    elementId: PlayerId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EventLive> =>
    pipe(
      cache.getEventLives(eventId),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Event live with element ID ${elementId} and event ID ${eventId} not found in cache.`,
          }),
        ),
      )((eventLives) => RA.findFirst((p: EventLive) => p.elementId === elementId)(eventLives)),
    );

  const findEventLivesByTeamId = (
    teamId: TeamId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EventLives> =>
    pipe(
      cache.getEventLives(eventId),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((eventLives) => RA.filter((p: EventLive) => p.teamId === teamId)(eventLives)),
    );

  const syncEventLiveCacheFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventService.isMatchDay(eventId),
      TE.chainW((isMatchDay) =>
        isMatchDay
          ? pipe(
              fplDataService.getLives(eventId),
              TE.mapLeft((error: DataLayerError) =>
                createServiceIntegrationError({
                  message: 'Failed to fetch event lives for cache update via data layer',
                  cause: error.cause,
                  details: error.details,
                }),
              ),
              TE.chainW((fetchedRawEventLives: RawEventLives) =>
                pipe(
                  enrichEventLives(playerCache, teamCache)(fetchedRawEventLives),
                  TE.mapLeft(mapDomainErrorToServiceError),
                ),
              ),
              TE.chainFirstW((enrichedEventLives: EventLives) =>
                pipe(
                  enrichedEventLives.length > 0
                    ? cache.setEventLives(enrichedEventLives)
                    : TE.rightIO(IO.of(undefined)),
                  TE.mapLeft(mapDomainErrorToServiceError),
                ),
              ),
              TE.map(() => undefined),
            )
          : TE.right(undefined),
      ),
    );

  const syncEventLivesFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventService.isMatchDay(eventId),
      TE.chainW((isMatchDay) =>
        isMatchDay
          ? pipe(
              fplDataService.getLives(eventId),
              TE.mapLeft((error: DataLayerError) =>
                createServiceIntegrationError({
                  message: 'Failed to fetch/map event lives via data layer',
                  cause: error.cause,
                  details: error.details,
                }),
              ),
              TE.chainFirstW(() =>
                pipe(domainOps.deleteEventLives(eventId), TE.mapLeft(mapDomainErrorToServiceError)),
              ),
              TE.chainW((rawEventLives: RawEventLives) =>
                pipe(
                  rawEventLives.length > 0
                    ? domainOps.saveEventLives(rawEventLives)
                    : TE.right([] as RawEventLives),
                  TE.mapLeft(mapDomainErrorToServiceError),
                ),
              ),
              TE.chainW((savedEventLives: RawEventLives) =>
                pipe(
                  enrichEventLives(playerCache, teamCache)(savedEventLives),
                  TE.mapLeft(mapDomainErrorToServiceError),
                ),
              ),
              TE.chainFirstW((enrichedEventLives: EventLives) =>
                pipe(
                  enrichedEventLives.length > 0
                    ? cache.setEventLives(enrichedEventLives)
                    : TE.rightIO(IO.of(undefined)),
                  TE.mapLeft(mapDomainErrorToServiceError),
                ),
              ),
              TE.map(() => undefined),
            )
          : TE.right(undefined),
      ),
    );

  return {
    findEventLives,
    findEventLiveByElementId,
    findEventLivesByTeamId,
    syncEventLiveCacheFromApi,
    syncEventLivesFromApi,
  };
};

export const createEventLiveService = (
  fplDataService: FplLiveDataService,
  repository: EventLiveRepository,
  cache: EventLiveCache,
  playerCache: PlayerCache,
  teamCache: TeamCache,
  eventService: EventService,
): EventLiveService => {
  const domainOps = createEventLiveOperations(repository);
  const ops = eventLiveServiceOperations(
    fplDataService,
    domainOps,
    cache,
    playerCache,
    teamCache,
    eventService,
  );

  return {
    getEventLives: (eventId: EventId): TE.TaskEither<ServiceError, EventLives> =>
      ops.findEventLives(eventId),
    getEventLiveByElementId: (
      elementId: PlayerId,
      eventId: EventId,
    ): TE.TaskEither<ServiceError, EventLive> => ops.findEventLiveByElementId(elementId, eventId),
    getEventLivesByTeamId: (
      teamId: TeamId,
      eventId: EventId,
    ): TE.TaskEither<ServiceError, EventLives> => ops.findEventLivesByTeamId(teamId, eventId),
    syncEventLiveCacheFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncEventLiveCacheFromApi(eventId),
    syncEventLivesFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncEventLivesFromApi(eventId),
  };
};
