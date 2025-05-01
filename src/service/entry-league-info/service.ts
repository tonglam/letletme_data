import { createEntryLeagueInfoOperations } from 'domain/entry-league-info/operation';
import { EntryLeagueInfoOperations } from 'domain/entry-league-info/types';

import { FplEntryDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EntryInfoRepository } from 'repository/entry-info/types';
import { EntryLeagueInfoRepository } from 'repository/entry-league-info/types';
import {
  EntryLeagueInfoService,
  EntryLeagueInfoServiceOperations,
} from 'service/entry-league-info/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import {
  createServiceError,
  DataLayerError,
  DomainError,
  ServiceError,
  ServiceErrorCode,
} from 'types/error.type';
import { createServiceIntegrationError } from 'utils/error.util';

const entryLeagueInfoServiceOperations = (
  fplDataService: FplEntryDataService,
  domainOps: EntryLeagueInfoOperations,
): EntryLeagueInfoServiceOperations => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<ServiceError, EntryLeagueInfos> =>
    pipe(
      domainOps.findByEntryId(entryId),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.NOT_FOUND,
          message: `Failed to find entry league info by id ${entryId}`,
          cause: error.cause,
        }),
      ),
    );

  const syncEntryLeagueInfosFromApi = (entryId: EntryId): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getLeagues(entryId),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: `Failed to sync entry league info from api for entry id ${entryId}`,
          cause: error.cause,
          details: error.details,
        }),
      ),
    );

  const syncLeaguesInfosFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      TE.sequenceArray(ids.map(syncEntryLeagueInfosFromApi)),
      TE.map(() => undefined),
    );

  return {
    findByEntryId,
    syncEntryLeagueInfosFromApi,
    syncLeaguesInfosFromApi,
  };
};

export const createEntryLeagueInfoService = (
  fplDataService: FplEntryDataService,
  repository: EntryLeagueInfoRepository,
  entryInfoRepository: EntryInfoRepository,
): EntryLeagueInfoService => {
  const domainOps = createEntryLeagueInfoOperations(repository);
  const ops = entryLeagueInfoServiceOperations(fplDataService, domainOps, entryInfoRepository);

  return {
    getEntryLeagueInfo: (id: EntryId): TE.TaskEither<ServiceError, EntryLeagueInfos> =>
      ops.findByEntryId(id),
    syncEntryLeagueInfosFromApi: (entryId: EntryId): TE.TaskEither<ServiceError, void> =>
      ops.syncEntryLeagueInfosFromApi(entryId),
    syncLeaguesInfosFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncLeaguesInfosFromApi(),
  };
};
