import { FplLiveDataService } from 'data/types';
import { createEventLiveExplainOperations } from 'domains/event-live-explain/operation';
import { EventLiveExplainOperations } from 'domains/event-live-explain/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { EventLiveExplainRepository } from 'repositories/event-live-explain/types';
import { EventService } from 'services/event/types';
import {
  EventLiveExplainService,
  EventLiveExplainServiceOperations,
} from 'services/event-live-explain/types';
import { EventLiveExplain, EventLiveExplains } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { createDomainError, DataLayerError, DomainErrorCode, ServiceError } from 'types/error.type';
import {
  createServiceIntegrationError,
  mapDBErrorToServiceError,
  mapDomainErrorToServiceError,
} from 'utils/error.util';

const eventLiveExplainServiceOperations = (
  fplDataService: FplLiveDataService,
  domainOps: EventLiveExplainOperations,
  repository: EventLiveExplainRepository,
  eventService: EventService,
): EventLiveExplainServiceOperations => {
  const findEventLiveExplainByElementId = (
    elementId: PlayerId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EventLiveExplain> =>
    pipe(
      repository.findByElementIdAndEventId(elementId, eventId),
      TE.mapLeft(mapDBErrorToServiceError),
      TE.chainOptionK<ServiceError>(
        (): ServiceError =>
          mapDomainErrorToServiceError(
            createDomainError({
              code: DomainErrorCode.NOT_FOUND,
              message: `Event live explain with element ID ${elementId} and event ID ${eventId} not found.`,
            }),
          ),
      )((eventLiveExplain): Option<EventLiveExplain> => O.fromNullable(eventLiveExplain)),
    );

  const syncEventLiveExplainsFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      eventService.isMatchDay(eventId),
      TE.chainW((isMatchDay) =>
        isMatchDay
          ? pipe(
              fplDataService.getExplains(eventId),
              TE.mapLeft((error: DataLayerError) =>
                createServiceIntegrationError({
                  message: 'Failed to fetch/map event live explains via data layer',
                  cause: error.cause,
                  details: error.details,
                }),
              ),
              TE.chainFirstW(() =>
                pipe(
                  domainOps.deleteEventLiveExplains(eventId),
                  TE.mapLeft(mapDomainErrorToServiceError),
                ),
              ),
              TE.chainW((eventLiveExplains: EventLiveExplains) =>
                pipe(
                  eventLiveExplains.length > 0
                    ? domainOps.saveEventLiveExplains(eventLiveExplains)
                    : TE.right([] as EventLiveExplains),
                  TE.mapLeft(mapDomainErrorToServiceError),
                ),
              ),
              TE.map(() => undefined),
            )
          : TE.right(undefined),
      ),
    );

  return {
    findEventLiveExplainByElementId,
    syncEventLiveExplainsFromApi,
  };
};

export const createEventLiveExplainService = (
  fplDataService: FplLiveDataService,
  eventService: EventService,
  repository: EventLiveExplainRepository,
): EventLiveExplainService => {
  const domainOps = createEventLiveExplainOperations(repository);
  const ops = eventLiveExplainServiceOperations(
    fplDataService,
    domainOps,
    repository,
    eventService,
  );

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
