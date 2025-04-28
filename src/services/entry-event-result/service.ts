import { createEntryEventResultOperations } from 'domains/entry-event-result/operation';
import { EntryEventResultOperations } from 'domains/entry-event-result/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import {
  EntryEventResultService,
  EntryEventResultServiceOperations,
} from 'services/entry-event-result/types';
import { EntryEventResultRepository } from 'src/repositories/entry-event-result/types';
import { EntryInfoRepository } from 'src/repositories/entry-info/types';
import { EntryEventResult, EntryEventResults } from 'src/types/domain/entry-event-result.type';
import { DBError, DomainError, ServiceError, ServiceErrorCode } from 'src/types/error.type';
import { createServiceError } from 'src/types/error.type';
import { enrichEntryEventResults } from 'src/utils/data-enrichment.util';

import { FplHistoryDataService } from '../../data/types';
import { EntryId } from '../../types/domain/entry-info.type';
import { EventId } from '../../types/domain/event.type';

const entryEventResultServiceOperations = (
  fplDataService: FplHistoryDataService,
  domainOps: EntryEventResultOperations,
  entryInfoRepository: EntryInfoRepository,
  logger: Logger,
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
          code: ServiceErrorCode.OPERATION_ERROR,
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
          code: ServiceErrorCode.OPERATION_ERROR,
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
          code: ServiceErrorCode.OPERATION_ERROR,
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
      TE.foldW(
        (errorInfo: {
          type: 'fetch' | 'extract' | 'upsert' | 'check_exists';
          error?: unknown;
          message?: string;
          entryId: EntryId;
        }) =>
          pipe(
            TE.tryCatch(
              async () =>
                logger.error(
                  { entryId: errorInfo.entryId, error: errorInfo },
                  `Failed to process entry history ${errorInfo.entryId} during sync: ${errorInfo.type}`,
                ),
              (err) => {
                console.error('CRITICAL: Logging failed during entry history sync error handling', {
                  entryId: errorInfo.entryId,
                  originalError: errorInfo,
                  loggingError: err,
                });
                return new Error('Logging failed');
              },
            ),
            TE.chainW(() => TE.right(undefined)),
            TE.orElseW(() => TE.right(undefined)),
          ),
        () => TE.right(undefined),
      ),
    );

  const syncResultsFromApi = (_eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      entryInfoRepository.findAllEntryIds(),
      TE.mapLeft((error: DBError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
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
  logger: Logger,
): EntryEventResultService => {
  const domainOps = createEntryEventResultOperations(repository);
  const ops = entryEventResultServiceOperations(
    fplDataService,
    domainOps,
    entryInfoRepository,
    logger,
  );

  return {
    getEntryEventResult: (entryId: EntryId, eventId: EventId) =>
      ops.findByEntryIdAndEventId(entryId, eventId),
    findByEntryIdsAndEventId: (entryIds: ReadonlyArray<EntryId>, eventId: EventId) =>
      ops.findByEntryIdsAndEventId(entryIds, eventId),
    findByEntryId: (id: EntryId) => ops.findByEntryId(id),
    syncResultsFromApi: (eventId: EventId) => ops.syncResultsFromApi(eventId),
  };
};
