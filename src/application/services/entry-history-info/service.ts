import { createEntryHistoryInfoOperations } from 'domain/entry-history-info/operation';
import { EntryHistoryInfoOperations } from 'domain/entry-history-info/types';

import { FplHistoryDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EntryHistoryInfoRepository } from 'repository/entry-history-info/types';
import {
  EntryHistoryInfoService,
  EntryHistoryInfoServiceOperations,
} from 'service/entry-history-info/types';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { DataLayerError, DomainError, ServiceError, ServiceErrorCode } from 'types/error.type';
import { createServiceError } from 'types/error.type';
import { createServiceIntegrationError } from 'utils/error.util';

const entryHistoryInfoServiceOperations = (
  fplDataService: FplHistoryDataService,
  domainOps: EntryHistoryInfoOperations,
): EntryHistoryInfoServiceOperations => {
  const findByEntryId = (id: EntryId): TE.TaskEither<ServiceError, EntryHistoryInfos> =>
    pipe(
      domainOps.findByEntryId(id),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to find entry history info by id',
          cause: error.cause,
        }),
      ),
    );

  const findAllEntryIds = (): TE.TaskEither<ServiceError, ReadonlyArray<EntryId>> =>
    pipe(
      domainOps.findAllEntryIds(),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.INTEGRATION_ERROR,
          message: 'Failed to find all entry ids',
          cause: error.cause,
        }),
      ),
    );

  const syncEntryHistoryInfosFromApi = (entryId: EntryId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getHistories(entryId),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: `Failed to fetch entry history info from api for entry id ${entryId}`,
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chain((histories) =>
        pipe(
          domainOps.saveBatchByEntryId(histories),
          TE.mapLeft((error: DomainError) =>
            createServiceError({
              code: ServiceErrorCode.DB_ERROR,
              message: `Failed to save entry history info for entry id ${entryId}`,
              cause: error.cause,
            }),
          ),
        ),
      ),
      TE.map(() => undefined),
    );

  const syncHistoryInfosFromApi = (
    ids: ReadonlyArray<EntryId>,
  ): TE.TaskEither<ServiceError, void> =>
    pipe(
      TE.sequenceArray(ids.map(syncEntryHistoryInfosFromApi)),
      TE.map(() => undefined),
    );

  return {
    findByEntryId,
    findAllEntryIds,
    syncEntryHistoryInfosFromApi,
    syncHistoryInfosFromApi,
  };
};

export const createEntryHistoryInfoService = (
  fplDataService: FplHistoryDataService,
  repository: EntryHistoryInfoRepository,
): EntryHistoryInfoService => {
  const domainOps = createEntryHistoryInfoOperations(repository);
  const ops = entryHistoryInfoServiceOperations(fplDataService, domainOps);

  return {
    getEntryHistoryInfo: (id: EntryId): TE.TaskEither<ServiceError, EntryHistoryInfos> =>
      ops.findByEntryId(id),
    getAllEntryIds: (): TE.TaskEither<ServiceError, ReadonlyArray<EntryId>> =>
      ops.findAllEntryIds(),
    syncEntryHistoryInfosFromApi: (entryId: EntryId): TE.TaskEither<ServiceError, void> =>
      ops.syncEntryHistoryInfosFromApi(entryId),
    syncHistoryInfosFromApi: (
      entryIds: ReadonlyArray<EntryId>,
    ): TE.TaskEither<ServiceError, void> => ops.syncHistoryInfosFromApi(entryIds),
  };
};
