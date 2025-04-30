import { EventOverallResultCache } from 'domain/event-overall-result/types';
import { PlayerCache } from 'domain/player/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import {
  EventOverallResultService,
  EventOverallResultServiceOperations,
} from 'service/event-overall-result/types';
import { EventOverallResult, RawEventOverallResult } from 'types/domain/event-overall-result.type';
import { EventId } from 'types/domain/event.type';
import { createDomainError, DataLayerError, DomainErrorCode, ServiceError } from 'types/error.type';
import { enrichEventOverallResult } from 'utils/data-enrichment.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const eventOverallResultServiceOperations = (
  fplDataService: FplBootstrapDataService,
  cache: EventOverallResultCache,
  playerCache: PlayerCache,
): EventOverallResultServiceOperations => {
  const findEventOverallResultById = (
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EventOverallResult> =>
    pipe(
      cache.getEventOverallResult(eventId),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Event overall result with ID ${eventId} not found in cache.`,
          }),
        ),
      )((eventOverallResult) =>
        RA.findFirst((p: EventOverallResult) => p.eventId === eventId)([eventOverallResult]),
      ),
    );

  const syncEventOverallResultsFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getEventOverallResults(eventId),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch event overall results via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chainW((rawResult: RawEventOverallResult) =>
        pipe(
          enrichEventOverallResult(playerCache)(rawResult),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.chainW((enrichedResult: EventOverallResult) =>
        pipe(
          cache.setAllEventOverallResults([enrichedResult]),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
      TE.map(() => undefined),
    );

  return {
    findEventOverallResultById,
    syncEventOverallResultsFromApi,
  };
};

export const createEventOverallResultService = (
  fplDataService: FplBootstrapDataService,
  cache: EventOverallResultCache,
  playerCache: PlayerCache,
): EventOverallResultService => {
  const ops = eventOverallResultServiceOperations(fplDataService, cache, playerCache);

  return {
    getEventOverallResult: (id: EventId): TE.TaskEither<ServiceError, EventOverallResult> =>
      ops.findEventOverallResultById(id),
    syncEventOverallResultsFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncEventOverallResultsFromApi(eventId),
  };
};
