import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RNEA from 'fp-ts/ReadonlyNonEmptyArray';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { EntryInfoService, EntryInfoServiceOperations } from 'services/entry-info/types';

import { FplEntryDataService } from '../../data/types';
import { createEntryInfoOperations } from '../../domains/entry-info/operation';
import { EntryInfoOperations } from '../../domains/entry-info/types';
import { EntryInfoRepository } from '../../repositories/entry-info/types';
import { EntryInfo, EntryId, EntryInfos } from '../../types/domain/entry-info.type';
import {
  createServiceError,
  DBError,
  DomainError,
  ServiceError,
  ServiceErrorCode,
} from '../../types/error.type';

const entryInfoServiceOperations = (
  fplDataService: FplEntryDataService,
  domainOps: EntryInfoOperations,
  repository: EntryInfoRepository,
  logger: Logger,
): EntryInfoServiceOperations => {
  const findById = (id: EntryId): TE.TaskEither<ServiceError, EntryInfo> =>
    pipe(
      domainOps.findById(id),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to find entry info by id',
          cause: error.cause,
        }),
      ),
    );

  const findByIds = (ids: ReadonlyArray<EntryId>): TE.TaskEither<ServiceError, EntryInfos> =>
    pipe(
      domainOps.findByIds(ids),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to find entry info by ids',
          cause: error.cause,
        }),
      ),
    );

  const processSingleEntry = (entryId: EntryId): TE.TaskEither<never, void> =>
    pipe(
      fplDataService.getInfos(entryId),
      TE.mapLeft((error) => ({ type: 'fetch' as const, error, entryId })),
      TE.chainW((fetchedInfos) =>
        pipe(
          RNEA.fromReadonlyArray(fetchedInfos),
          O.map(RNEA.head),
          TE.fromOption(() => ({
            type: 'extract' as const,
            message: `No data for entry ${entryId}`,
            entryId,
          })),
        ),
      ),
      TE.chainW((fetchedEntryInfo) =>
        pipe(
          domainOps.upsertEntryInfo(fetchedEntryInfo),
          TE.mapLeft((error) => ({ type: 'upsert' as const, error, entryId })),
        ),
      ),
      TE.map(() => undefined),
      TE.foldW(
        (errorInfo: {
          type: 'fetch' | 'extract' | 'upsert';
          error?: unknown;
          message?: string;
          entryId: EntryId;
        }) =>
          pipe(
            TE.tryCatch(
              async () =>
                logger.error(
                  { entryId: errorInfo.entryId, error: errorInfo },
                  `Failed to process entry ${errorInfo.entryId} during sync: ${errorInfo.type}`,
                ),
              (err) => {
                console.error('CRITICAL: Logging failed during entry sync error handling', {
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

  const syncEntryInfosFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      repository.findAllEntryIds(),
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
    findById,
    findByIds,
    syncEntryInfosFromApi,
  };
};

export const createEntryInfoService = (
  fplDataService: FplEntryDataService,
  repository: EntryInfoRepository,
  logger: Logger,
): EntryInfoService => {
  const domainOps = createEntryInfoOperations(repository);
  const ops = entryInfoServiceOperations(fplDataService, domainOps, repository, logger);

  return {
    getEntryInfo: (id: EntryId): TE.TaskEither<ServiceError, EntryInfo> => ops.findById(id),
    getEntryInfoByIds: (ids: ReadonlyArray<EntryId>): TE.TaskEither<ServiceError, EntryInfos> =>
      ops.findByIds(ids),
    syncEntryInfosFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncEntryInfosFromApi(),
  };
};
