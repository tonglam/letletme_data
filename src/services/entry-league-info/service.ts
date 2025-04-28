import { FplEntryDataService } from 'data/types';
import { createEntryLeagueInfoOperations } from 'domains/entry-league-info/operation';
import { EntryLeagueInfoOperations } from 'domains/entry-league-info/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as RNEA from 'fp-ts/ReadonlyNonEmptyArray';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { EntryInfoRepository } from 'repositories/entry-info/types';
import { EntryLeagueInfoRepository } from 'repositories/entry-league-info/types';
import {
  EntryLeagueInfoService,
  EntryLeagueInfoServiceOperations,
} from 'services/entry-league-info/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import {
  createServiceError,
  DBError,
  DomainError,
  ServiceError,
  ServiceErrorCode,
} from 'types/error.type';

const entryLeagueInfoServiceOperations = (
  fplDataService: FplEntryDataService,
  domainOps: EntryLeagueInfoOperations,
  entryInfoRepository: EntryInfoRepository,
  logger: Logger,
): EntryLeagueInfoServiceOperations => {
  const findByEntryId = (id: EntryId): TE.TaskEither<ServiceError, EntryLeagueInfos> =>
    pipe(
      domainOps.findByEntryId(id),
      TE.mapLeft((error: DomainError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to find entry league info by id',
          cause: error.cause,
        }),
      ),
    );

  const processSingleEntry = (entryId: EntryId): TE.TaskEither<never, void> =>
    pipe(
      fplDataService.getLeagues(entryId),
      TE.mapLeft((error) => ({ type: 'fetch' as const, error, entryId })),
      TE.chainW((fetchedLeagues) =>
        pipe(
          RNEA.fromReadonlyArray(fetchedLeagues),
          O.map(RNEA.head),
          TE.fromOption(() => ({
            type: 'extract' as const,
            message: `No data for entry ${entryId}`,
            entryId,
          })),
        ),
      ),
      TE.chainW((fetchedLeagueInfo) =>
        pipe(
          domainOps.upsertEntryLeagueInfo(fetchedLeagueInfo),
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
                console.error(
                  'CRITICAL: Logging failed during entry league info sync error handling',
                  {
                    entryId: errorInfo.entryId,
                    originalError: errorInfo,
                    loggingError: err,
                  },
                );
                return new Error('Logging failed');
              },
            ),
            TE.chainW(() => TE.right(undefined)),
            TE.orElseW(() => TE.right(undefined)),
          ),
        () => TE.right(undefined),
      ),
    );

  const syncEntryLeagueInfosFromApi = (): TE.TaskEither<ServiceError, void> =>
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
    syncEntryLeagueInfosFromApi,
  };
};

export const createEntryLeagueInfoService = (
  fplDataService: FplEntryDataService,
  repository: EntryLeagueInfoRepository,
  entryInfoRepository: EntryInfoRepository,
  logger: Logger,
): EntryLeagueInfoService => {
  const domainOps = createEntryLeagueInfoOperations(repository);
  const ops = entryLeagueInfoServiceOperations(
    fplDataService,
    domainOps,
    entryInfoRepository,
    logger,
  );

  return {
    getEntryLeagueInfo: (id: EntryId): TE.TaskEither<ServiceError, EntryLeagueInfos> =>
      ops.findByEntryId(id),
    syncEntryLeagueInfosFromApi: (): TE.TaskEither<ServiceError, void> =>
      ops.syncEntryLeagueInfosFromApi(),
  };
};
