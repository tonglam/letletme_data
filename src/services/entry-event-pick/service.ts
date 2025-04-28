import { FplPickDataService } from 'data/types';
import { createEntryEventPickOperations } from 'domains/entry-event-pick/operation';
import { EntryEventPickOperations } from 'domains/entry-event-pick/types';
import { PlayerCache } from 'domains/player/types';
import { TeamCache } from 'domains/team/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { EntryEventPickRepository } from 'repositories/entry-event-pick/types';
import { EntryInfoRepository } from 'repositories/entry-info/types';
import { TournamentEntryRepository } from 'repositories/tournament-entry/types';
import {
  EntryEventPickService,
  EntryEventPickServiceOperations,
} from 'services/entry-event-pick/types';
import { RawEntryEventPicks, EntryEventPick } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import {
  createServiceError,
  DBError,
  DomainError,
  DomainErrorCode,
  ServiceError,
  ServiceErrorCode,
} from 'types/error.type';
import { enrichEntryEventPick } from 'utils/data-enrichment.util';

const entryEventPickServiceOperations = (
  fplDataService: FplPickDataService,
  domainOps: EntryEventPickOperations,
  entryInfoRepository: EntryInfoRepository,
  tournamentEntryRepository: TournamentEntryRepository,
  playerCache: PlayerCache,
  teamCache: TeamCache,
  logger: Logger,
): EntryEventPickServiceOperations => {
  const enrichPick = enrichEntryEventPick(playerCache, teamCache, entryInfoRepository);

  const findByEntryIdAndEventId = (
    id: EntryId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EntryEventPick> =>
    pipe(
      domainOps.findByEntryIdAndEventId(id, eventId),
      TE.chainW(enrichPick),
      TE.mapLeft((error: DomainError | DBError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to find and enrich entry event pick by id and event id',
          cause: error.cause,
        }),
      ),
    );

  const checkPickExists = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DomainError, boolean> =>
    pipe(
      domainOps.findByEntryIdAndEventId(entryId, eventId),
      TE.map(() => true),
      TE.orElseW((error) =>
        error.code === DomainErrorCode.NOT_FOUND || error.code === DomainErrorCode.DATABASE_ERROR
          ? TE.right(false)
          : TE.left(error),
      ),
    );

  const processSingleEntry =
    (eventId: EventId) =>
    (entryId: EntryId): TE.TaskEither<never, void> =>
      pipe(
        fplDataService.getPicks(entryId, eventId),
        TE.mapLeft((error) => ({
          type: 'fetch' as const,
          error,
          entryId,
          eventId,
        })),
        TE.chainW((fetchedPicksArray: RawEntryEventPicks) =>
          pipe(
            checkPickExists(entryId, eventId),
            TE.mapLeft((error) => ({
              type: 'check_exists' as const,
              error,
              entryId,
              eventId,
            })),
            TE.chainW((exists) =>
              !exists
                ? pipe(
                    domainOps.saveBatchByEntryIdAndEventId(fetchedPicksArray),
                    TE.map(() => undefined),
                    TE.mapLeft((error) => ({
                      type: 'upsert' as const,
                      error,
                      entryId,
                      eventId,
                    })),
                  )
                : TE.right(undefined),
            ),
          ),
        ),
        TE.foldW(
          (errorInfo: { type: string; error?: unknown; entryId: EntryId; eventId: EventId }) =>
            pipe(
              TE.tryCatch(
                async () =>
                  logger.error(
                    { entryId: errorInfo.entryId, eventId: errorInfo.eventId, error: errorInfo },
                    `Failed to process entry event pick ${errorInfo.entryId} for event ${errorInfo.eventId} during sync: ${errorInfo.type}`,
                  ),
                (err) => {
                  console.error(
                    'CRITICAL: Logging failed during entry event pick sync error handling',
                    {
                      entryId: errorInfo.entryId,
                      eventId: errorInfo.eventId,
                      originalError: errorInfo,
                      loggingError: err,
                    },
                  );
                  return new Error('Logging failed');
                },
              ),
              TE.map(() => undefined),
              TE.orElseW(() => TE.right(undefined)),
            ),
          () => TE.right(undefined),
        ),
      );

  const syncPicksFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
    pipe(
      tournamentEntryRepository.findAllTournamentEntryIds(),
      TE.mapLeft((error: DBError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to find all tournament entry ids',
          cause: error.cause,
        }),
      ),
      TE.chainW((readonlyEntryIds) =>
        pipe(
          [...readonlyEntryIds],
          A.traverse(TE.ApplicativePar)(processSingleEntry(eventId)),
          TE.map(() => undefined),
        ),
      ),
    );

  return {
    findByEntryIdAndEventId,
    syncPicksFromApi,
  };
};

export const createEntryEventPickService = (
  fplDataService: FplPickDataService,
  repository: EntryEventPickRepository,
  entryInfoRepository: EntryInfoRepository,
  tournamentEntryRepository: TournamentEntryRepository,
  playerCache: PlayerCache,
  teamCache: TeamCache,
  logger: Logger,
): EntryEventPickService => {
  const domainOps = createEntryEventPickOperations(repository);
  const ops = entryEventPickServiceOperations(
    fplDataService,
    domainOps,
    entryInfoRepository,
    tournamentEntryRepository,
    playerCache,
    teamCache,
    logger,
  );

  return {
    getEntryEventPick: (
      id: EntryId,
      eventId: EventId,
    ): TE.TaskEither<ServiceError, EntryEventPick> => ops.findByEntryIdAndEventId(id, eventId),
    syncPicksFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncPicksFromApi(eventId),
  };
};
