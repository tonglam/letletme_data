import { createEntryEventPickOperations } from 'domains/entry-event-pick/operation';
import { EntryEventPickOperations } from 'domains/entry-event-pick/types';
import { createEntryHistoryInfoOperations } from 'domains/entry-history-info/operation';
import { EntryHistoryInfoOperations } from 'domains/entry-history-info/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import {
  EntryEventPickService,
  EntryEventPickServiceOperations,
} from 'services/entry-event-pick/types';
import {
  EntryHistoryInfoService,
  EntryHistoryInfoServiceOperations,
} from 'services/entry-history-info/types';
import { EntryEventPickRepository } from 'src/repositories/entry-event-pick/types';
import { EntryHistoryInfoRepository } from 'src/repositories/entry-history-info/types';
import { EntryInfoRepository } from 'src/repositories/entry-info/types';
import { EntryEventPick } from 'src/types/domain/entry-event-pick.type';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { EventId } from 'src/types/domain/event.type';
import { DBError, DomainError, ServiceError, ServiceErrorCode } from 'src/types/error.type';
import { createServiceError } from 'src/types/error.type';

import { FplLiveDataService } from '../../data/types';
import { EntryId } from '../../types/domain/entry-info.type';

const entryEventPickServiceOperations = (
  fplDataService: FplLiveDataService,
  domainOps: EntryEventPickOperations,
  entryInfoRepository: EntryInfoRepository,
  logger: Logger,
): EntryEventPickServiceOperations => {
  const findByEntryIdAndEventId = (
    id: EntryId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EntryEventPick> =>
    pipe(
      domainOps.findByEntryId(id),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to find entry history info by id',
          cause: error.cause,
        }),
      ),
    );

  const deleteByEntryId = (id: EntryId): TE.TaskEither<ServiceError, void> =>
    pipe(
      domainOps.deleteByEntryId(id),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to delete entry history info by id',
          cause: error.cause,
        }),
      ),
    );

  const processSingleEntry = (entryId: EntryId): TE.TaskEither<never, void> =>
    pipe(
      fplDataService.getHistories(entryId),
      TE.mapLeft((error) => ({ type: 'fetch' as const, error, entryId })),
      TE.chainW((fetchedHistoriesArray) =>
        pipe(
          domainOps.findByEntryId(entryId),
          TE.mapLeft((error) => ({ type: 'check_exists' as const, error, entryId })),
          TE.chainW((existingHistories) =>
            existingHistories.length === 0
              ? pipe(
                  domainOps.saveBatchByEntryId(fetchedHistoriesArray),
                  TE.map(() => undefined),
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

  const syncEntryEventPicksFromApi = (): TE.TaskEither<ServiceError, void> =>
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
    deleteByEntryId,
    syncEntryEventPicksFromApi,
  };
};

export const createEntryEventPickService = (
  fplDataService: FplLiveDataService,
  repository: EntryEventPickRepository,
  entryInfoRepository: EntryInfoRepository,
  logger: Logger,
): EntryEventPickService => {
  const domainOps = createEntryEventPickOperations(repository);
  const ops = entryEventPickServiceOperations(
    fplDataService,
    domainOps,
    entryInfoRepository,
    logger,
  );

  return {
    getEntryEventPick: (
      id: EntryId,
      eventId: EventId,
    ): TE.TaskEither<ServiceError, EntryEventPick> => ops.findByEntryIdAndEventId(id, eventId),
    deleteEntryEventPickByEntryId: (id: EntryId): TE.TaskEither<ServiceError, void> =>
      ops.deleteByEntryId(id),
    syncEntryEventPicksFromApi: (): TE.TaskEither<ServiceError, void> =>
      ops.syncEntryEventPicksFromApi(),
  };
};
