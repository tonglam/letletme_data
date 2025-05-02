import { createEntryEventResultOperations } from 'domain/entry-event-result/operation';
import { EntryEventResultOperations } from 'domain/entry-event-result/types';

import { FplHistoryDataService } from 'data/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EntryEventResultRepository } from 'repository/entry-event-result/types';
import { EntryInfoRepository } from 'repository/entry-info/types';
import {
  EntryEventResultService,
  EntryEventResultServiceOperations,
} from 'service/entry-event-result/types';
import { EntryEventResult, EntryEventResults } from 'types/domain/entry-event-result.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import {
  createServiceError,
  DBError,
  DomainError,
  ServiceError,
  ServiceErrorCode,
} from 'types/error.type';
import { enrichEntryEventResults } from 'utils/data-enrichment.util';

const entryEventResultServiceOperations = (
  fplDataService: FplHistoryDataService,
  domainOps: EntryEventResultOperations,
  entryInfoRepository: EntryInfoRepository,
): EntryEventResultServiceOperations => {
  const enrichResults = enrichEntryEventResults(entryInfoRepository);

  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EntryEventResult> =>
    pipe(
      domainOps.findByEntryIdAndEventId(entryId, eventId),
      TE.chainW(enrichResults),
      TE.map((result) => result as EntryEventResult),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to find and enrich entry event result by id and event id',
          cause: error,
        }),
      ),
    );

  const findByEntryIdsAndEventId = (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EntryEventResults> =>
    pipe(
      domainOps.findByEntryIdsAndEventId(entryIds, eventId),
      TE.chainW(enrichResults),
      TE.map((results) => results as EntryEventResults),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to find and enrich entry event results by ids and event id',
          cause: error,
        }),
      ),
    );

  const findByEntryId = (id: EntryId): TE.TaskEither<ServiceError, EntryEventResults> =>
    pipe(
      domainOps.findByEntryId(id),
      TE.chainW(enrichResults),
      TE.map((results) => results as EntryEventResults),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to find and enrich entry event results by id',
          cause: error,
        }),
      ),
    );

  const processSingleEntry = (entryId: EntryId): TE.TaskEither<never, void> =>
    pipe(
      fplDataService.getHistories(entryId),
      TE.mapLeft((error) => ({ type: 'fetch' as const, error, entryId })),
      TE.chainW((_fetchedHistoriesArray) =>
        pipe(
          domainOps.findByEntryId(entryId),
          TE.mapLeft((error) => ({ type: 'check_exists' as const, error, entryId })),
          TE.chainW((existingHistories) =>
            existingHistories.length === 0
              ? pipe(
                  TE.right(undefined),
                  TE.mapLeft((error) => ({ type: 'upsert' as const, error, entryId })),
                )
              : TE.right(undefined),
          ),
        ),
      ),
      TE.orElseW(() => TE.right(undefined)),
    );

  const syncResultsFromApi = (_eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      entryInfoRepository.findAllIds(),
      TE.mapLeft((error: DBError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to find all entry ids',
          cause: error.cause,
        }),
      ),
      TE.chainW((readonlyEntryIds) =>
        pipe(
          [...readonlyEntryIds],
          A.traverse(TE.ApplicativePar)(processSingleEntry),
          TE.map(() => undefined),
        ),
      ),
    );

  return {
    findByEntryIdAndEventId,
    findByEntryIdsAndEventId,
    findByEntryId,
    syncResultsFromApi,
  };
};

export const createEntryEventResultService = (
  fplDataService: FplHistoryDataService,
  repository: EntryEventResultRepository,
  entryInfoRepository: EntryInfoRepository,
): EntryEventResultService => {
  const domainOps = createEntryEventResultOperations(repository);
  const ops = entryEventResultServiceOperations(fplDataService, domainOps, entryInfoRepository);

  return {
    getEntryEventResult: (entryId: EntryId, eventId: EventId) =>
      ops.findByEntryIdAndEventId(entryId, eventId),
    findByEntryIdsAndEventId: (entryIds: ReadonlyArray<EntryId>, eventId: EventId) =>
      ops.findByEntryIdsAndEventId(entryIds, eventId),
    findByEntryId: (id: EntryId) => ops.findByEntryId(id),
    syncResultsFromApi: (eventId: EventId) => ops.syncResultsFromApi(eventId),
  };
};
