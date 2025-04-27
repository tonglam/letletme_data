import { createEventLiveOperations } from 'domains/event-live/operation';
import { EventLiveCache, EventLiveOperations } from 'domains/event-live/types';
import { PlayerCache } from 'domains/player/types';
import { TeamCache } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as IO from 'fp-ts/IO';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { FplLiveDataService } from 'src/data/types';
import { EventLiveRepository } from 'src/repositories/event-live/types';
import { EventService } from 'src/services/event/types';
import { EventLive, EventLives, RawEventLives } from 'src/types/domain/event-live.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';
import {
  createDomainError,
  DataLayerError,
  DomainErrorCode,
  ServiceError,
} from 'src/types/error.type';
import { enrichEventLives } from 'src/utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

import { EventLiveService, EventLiveServiceOperations } from './types';

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
