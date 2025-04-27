import { createEntryHistoryInfoOperations } from 'domains/entry-history-info/operation';
import { EntryHistoryInfoOperations } from 'domains/entry-history-info/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import {
  EntryHistoryInfoService,
  EntryHistoryInfoServiceOperations,
} from 'services/entry-history-info/types';
import { EntryHistoryInfoRepository } from 'src/repositories/entry-history-info/types';
import { EntryInfoRepository } from 'src/repositories/entry-info/types';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { DBError, DomainError, ServiceError, ServiceErrorCode } from 'src/types/error.type';
import { createServiceError } from 'src/types/error.type';

import { FplHistoryDataService } from '../../data/types';
import { EntryId } from '../../types/domain/entry-info.type';

const entryHistoryInfoServiceOperations = (
  fplDataService: FplHistoryDataService,
  domainOps: EntryHistoryInfoOperations,
  entryInfoRepository: EntryInfoRepository,
  logger: Logger,
): EntryHistoryInfoServiceOperations => {
  const findByEntryId = (id: EntryId): TE.TaskEither<ServiceError, EntryHistoryInfos> =>
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

  const syncEntryHistoryInfosFromApi = (): TE.TaskEither<ServiceError, void> =>
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
    findByEntryId,
    syncEntryHistoryInfosFromApi,
  };
};

export const createEntryHistoryInfoService = (
  fplDataService: FplHistoryDataService,
  repository: EntryHistoryInfoRepository,
  entryInfoRepository: EntryInfoRepository,
  logger: Logger,
): EntryHistoryInfoService => {
  const domainOps = createEntryHistoryInfoOperations(repository);
  const ops = entryHistoryInfoServiceOperations(
    fplDataService,
    domainOps,
    entryInfoRepository,
    logger,
  );

  return {
    getEntryHistoryInfo: (id: EntryId): TE.TaskEither<ServiceError, EntryHistoryInfos> =>
      ops.findByEntryId(id),
    syncEntryHistoryInfosFromApi: (): TE.TaskEither<ServiceError, void> =>
      ops.syncEntryHistoryInfosFromApi(),
  };
};
