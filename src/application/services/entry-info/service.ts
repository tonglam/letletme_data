import { createEntryInfoOperations } from 'domain/entry-info/operation';
import { EntryInfoOperations } from 'domain/entry-info/types';

import { FplEntryDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EntryInfoRepository } from 'repository/entry-info/types';
import { EntryInfoService, EntryInfoServiceOperations } from 'service/entry-info/types';
import { EntryId, EntryInfo } from 'types/domain/entry-info.type';
import { EntryInfos } from 'types/domain/entry-info.type';
import {
  DataLayerError,
  DomainError,
  createServiceError,
  ServiceErrorCode,
} from 'types/error.type';
import { ServiceError } from 'types/error.type';
import { createServiceIntegrationError, mapCacheErrorToServiceError } from 'utils/error.util';

const entryInfoServiceOperations = (
  fplDataService: FplEntryDataService,
  domainOps: EntryInfoOperations,
): EntryInfoServiceOperations => {
  const findById = (id: EntryId): TE.TaskEither<ServiceError, EntryInfo> =>
    pipe(
      domainOps.findById(id),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.NOT_FOUND,
          message: `Entry info with id ${id} not found`,
          cause: error.cause,
        }),
      ),
    );

  const findByIds = (ids: ReadonlyArray<EntryId>): TE.TaskEither<ServiceError, EntryInfos> =>
    pipe(
      domainOps.findByIds(ids),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.NOT_FOUND,
          message: `Entry info with ids ${ids.join(', ')} not found`,
          cause: error.cause,
        }),
      ),
    );

  const findAllIds = (): TE.TaskEither<ServiceError, ReadonlyArray<EntryId>> =>
    pipe(domainOps.findAllIds(), TE.mapLeft(mapCacheErrorToServiceError));

  const syncEntryInfoFromApi = (id: EntryId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getInfo(id),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: `Failed to sync entry info from api for entry id ${id}`,
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chainW((entryInfo) =>
        pipe(
          domainOps.upsertEntryInfo(entryInfo),
          TE.mapLeft((error: DomainError) =>
            createServiceError({
              code: ServiceErrorCode.INTEGRATION_ERROR,
              message: `Failed to upsert entry info for entry id ${id}`,
              cause: error.cause,
            }),
          ),
        ),
      ),
      TE.map(() => undefined),
    );

  const syncEntryInfosFromApi = (ids: ReadonlyArray<EntryId>): TE.TaskEither<ServiceError, void> =>
    pipe(
      TE.sequenceArray(ids.map(syncEntryInfoFromApi)),
      TE.map(() => undefined),
    );

  return {
    findById,
    findByIds,
    findAllIds,
    syncEntryInfoFromApi,
    syncEntryInfosFromApi,
  };
};

export const createEntryInfoService = (
  fplDataService: FplEntryDataService,
  repository: EntryInfoRepository,
): EntryInfoService => {
  const domainOps = createEntryInfoOperations(repository);
  const ops = entryInfoServiceOperations(fplDataService, domainOps);

  return {
    getEntryInfo: (id: EntryId): TE.TaskEither<ServiceError, EntryInfo> => ops.findById(id),
    getEntryInfoByIds: (ids: ReadonlyArray<EntryId>): TE.TaskEither<ServiceError, EntryInfos> =>
      ops.findByIds(ids),
    getAllEntryIds: (): TE.TaskEither<ServiceError, ReadonlyArray<EntryId>> => ops.findAllIds(),
    syncEntryInfoFromApi: (id: EntryId): TE.TaskEither<ServiceError, void> =>
      ops.syncEntryInfoFromApi(id),
    syncEntryInfosFromApi: (ids: ReadonlyArray<EntryId>): TE.TaskEither<ServiceError, void> =>
      ops.syncEntryInfosFromApi(ids),
  };
};
