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
  teamCache: TeamCache,
  playerCache: PlayerCache,
  eventService: EventService,
): EventLiveServiceOperations => {
  const findEventLives = (eventId: EventId): TE.TaskEither<ServiceError, EventLives> =>
    pipe(cache.getEventLives(eventId), TE.mapLeft(mapDomainErrorToServiceError));

  const findEventLiveByElementId = (
    eventId: EventId,
    elementId: PlayerId,
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
    eventId: EventId,
    teamId: TeamId,
  ): TE.TaskEither<ServiceError, EventLives> =>
    pipe(
      cache.getEventLives(eventId),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.map((eventLives) => RA.filter((p: EventLive) => p.teamId === teamId)(eventLives)),
    );

  const syncEventLiveCacheFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getLives(eventId),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch event lives for cache update via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chainFirstW((rawEventLives) =>
        rawEventLives.length > 0
          ? pipe(
              domainOps.saveEventLives(rawEventLives),
              TE.mapLeft(mapDomainErrorToServiceError),
              TE.as(undefined),
            )
          : TE.right(undefined),
      ),
      TE.chainW((rawEventLives) =>
        pipe(
          enrichEventLives(playerCache, teamCache)(rawEventLives),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainFirstW((enrichedEventLives) =>
        enrichedEventLives.length > 0
          ? pipe(cache.setEventLives(enrichedEventLives), TE.mapLeft(mapDomainErrorToServiceError))
          : TE.rightIO(IO.of(undefined)),
      ),
      TE.map(() => undefined),
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
  teamCache: TeamCache,
  playerCache: PlayerCache,
  eventService: EventService,
): EventLiveService => {
  const domainOps = createEventLiveOperations(repository);
  const ops = eventLiveServiceOperations(
    fplDataService,
    domainOps,
    cache,
    teamCache,
    playerCache,
    eventService,
  );

  return {
    getEventLives: (eventId: EventId): TE.TaskEither<ServiceError, EventLives> =>
      ops.findEventLives(eventId),
    getEventLiveByElementId: (
      eventId: EventId,
      elementId: PlayerId,
    ): TE.TaskEither<ServiceError, EventLive> => ops.findEventLiveByElementId(eventId, elementId),
    getEventLivesByTeamId: (
      eventId: EventId,
      teamId: TeamId,
    ): TE.TaskEither<ServiceError, EventLives> => ops.findEventLivesByTeamId(eventId, teamId),
    syncEventLiveCacheFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncEventLiveCacheFromApi(eventId),
    syncEventLivesFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncEventLivesFromApi(eventId),
  };
};
