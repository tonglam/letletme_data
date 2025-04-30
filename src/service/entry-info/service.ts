import { createEntryInfoOperations } from 'domain/entry-info/operation';
import { EntryInfoOperations } from 'domain/entry-info/types';

import { FplEntryDataService } from 'data/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RNEA from 'fp-ts/ReadonlyNonEmptyArray';
import * as TE from 'fp-ts/TaskEither';
import { EntryInfoRepository } from 'repository/entry-info/types';
import { EntryInfoService, EntryInfoServiceOperations } from 'service/entry-info/types';
import { EntryInfo, EntryId, EntryInfos } from 'types/domain/entry-info.type';
import {
  createServiceError,
  DBError,
  DomainError,
  ServiceError,
  ServiceErrorCode,
} from 'types/error.type';

const entryInfoServiceOperations = (
  fplDataService: FplEntryDataService,
  domainOps: EntryInfoOperations,
  repository: EntryInfoRepository,
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

  const syncEntryInfosFromApi = (entryId: EntryId): TE.TaskEither<ServiceError, void> =>
    pipe(
      domainOps.syncEntryInfosFromApi(entryId),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to sync entry info from api',
          cause: error.cause,
        }),
      ),
      TE.map(() => undefined),
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
): EntryInfoService => {
  const domainOps = createEntryInfoOperations(repository);
  const ops = entryInfoServiceOperations(fplDataService, domainOps, repository);

  return {
    getEntryInfo: (id: EntryId): TE.TaskEither<ServiceError, EntryInfo> => ops.findById(id),
    getEntryInfoByIds: (ids: ReadonlyArray<EntryId>): TE.TaskEither<ServiceError, EntryInfos> =>
      ops.findByIds(ids),
    syncEntryInfosFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncEntryInfosFromApi(),
  };
};
