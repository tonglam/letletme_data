import { createEventLiveExplainOperations } from 'domain/event-live-explain/operation';
import { EventLiveExplainOperations } from 'domain/event-live-explain/types';

import { FplLiveDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { EventLiveExplainRepository } from 'repository/event-live-explain/types';
import {
  EventLiveExplainService,
  EventLiveExplainServiceOperations,
} from 'service/event-live-explain/types';
import { EventLiveExplain, EventLiveExplains } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { createDomainError, DataLayerError, DomainErrorCode, ServiceError } from 'types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const eventLiveExplainServiceOperations = (
  fplDataService: FplLiveDataService,
  domainOps: EventLiveExplainOperations,
  cache: EventLiveExplainCache,
): EventLiveExplainServiceOperations => {
  const findEventLiveExplainByElementId = (
    elementId: PlayerId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EventLiveExplain> =>
    pipe(
      cache.getEventLiveExplains(eventId),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Event live explain with element ID ${elementId} and event ID ${eventId} not found in cache.`,
          }),
        ),
      )((eventLiveExplains) =>
        RA.findFirst((p: EventLiveExplain) => p.elementId === elementId)(eventLiveExplains),
      ),
    );

  const syncEventLiveExplainsFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getExplains(eventId),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map event live explains via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chainFirstW(() =>
        pipe(domainOps.deleteEventLiveExplains(eventId), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainW((eventLiveExplains: EventLiveExplains) =>
        pipe(
          eventLiveExplains.length > 0
            ? domainOps.saveEventLiveExplains(eventLiveExplains)
            : TE.right([] as EventLiveExplains),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainFirstW((enrichedEventLiveExplains: EventLiveExplains) =>
        pipe(
          enrichedEventLiveExplains.length > 0
            ? cache.setEventLiveExplains(enrichedEventLiveExplains)
            : TE.rightIO(() => {}),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.map(() => undefined),
    );

  return {
    findEventLiveExplainByElementId,
    syncEventLiveExplainsFromApi,
  };
};

export const createEventLiveExplainService = (
  fplDataService: FplLiveDataService,
  repository: EventLiveExplainRepository,
  cache: EventLiveExplainCache,
): EventLiveExplainService => {
  const domainOps = createEventLiveExplainOperations(repository);
  const ops = eventLiveExplainServiceOperations(fplDataService, domainOps, cache);

  return {
    getEventLiveExplainByElementId: (
      elementId: PlayerId,
      eventId: EventId,
    ): TE.TaskEither<ServiceError, EventLiveExplain> =>
      ops.findEventLiveExplainByElementId(elementId, eventId),
    syncEventLiveExplainsFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncEventLiveExplainsFromApi(eventId),
  };
};
