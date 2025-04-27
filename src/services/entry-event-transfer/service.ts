import { createEntryEventTransferOperations } from 'domains/entry-event-transfer/operation';
import { EntryEventTransferOperations } from 'domains/entry-event-transfer/types';
import { PlayerCache } from 'domains/player/types';
import { TeamCache } from 'domains/team/types';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import {
  EntryEventTransferService,
  EntryEventTransferServiceOperations,
} from 'services/entry-event-transfer/types';
import { EntryEventTransferRepository } from 'src/repositories/entry-event-transfer/types';
import { EntryInfoRepository } from 'src/repositories/entry-info/types';
import { TournamentEntryRepository } from 'src/repositories/tournament-entry/types';
import {
  EntryEventTransfers,
  RawEntryEventTransfers,
} from 'src/types/domain/entry-event-transfer.type';
import { EventId } from 'src/types/domain/event.type';
import {
  DBError,
  DomainError,
  DomainErrorCode,
  ServiceError,
  ServiceErrorCode,
} from 'src/types/error.type';
import { createServiceError } from 'src/types/error.type';
import { enrichEntryEventTransfers } from 'src/utils/data-enrichment.util';

import { FplTransferDataService } from '../../data/types';
import { EntryId } from '../../types/domain/entry-info.type';

const entryEventTransferServiceOperations = (
  fplDataService: FplTransferDataService,
  domainOps: EntryEventTransferOperations,
  entryInfoRepository: EntryInfoRepository,
  tournamentEntryRepository: TournamentEntryRepository,
  playerCache: PlayerCache,
  teamCache: TeamCache,
  logger: Logger,
): EntryEventTransferServiceOperations => {
  const enrichTransfers = enrichEntryEventTransfers(playerCache, teamCache, entryInfoRepository);

  const findByEntryIdAndEventId = (
    id: EntryId,
    eventId: EventId,
  ): TE.TaskEither<ServiceError, EntryEventTransfers> =>
    pipe(
      domainOps.findByEntryIdAndEventId(id, eventId),
      TE.chainW(enrichTransfers),
      TE.mapLeft((error: DomainError | DBError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to find and enrich entry event transfers by id and event id',
          cause: error.cause,
        }),
      ),
    );

  const checkTransferExists = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DomainError, boolean> =>
    pipe(
      domainOps.findByEntryIdAndEventId(entryId, eventId),
      TE.map((transfers) => transfers.length > 0),
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
        fplDataService.getTransfers(entryId, eventId),
        TE.mapLeft((error) => ({
          type: 'fetch' as const,
          error,
          entryId,
          eventId,
        })),
        TE.chainW((fetchedTransfersArray: RawEntryEventTransfers) =>
          fetchedTransfersArray.length > 0
            ? pipe(
                checkTransferExists(entryId, eventId),
                TE.mapLeft((error) => ({
                  type: 'check_exists' as const,
                  error,
                  entryId,
                  eventId,
                })),
                TE.chainW((exists) =>
                  !exists
                    ? pipe(
                        domainOps.saveBatchByEntryIdAndEventId(fetchedTransfersArray),
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
              )
            : TE.right(undefined),
        ),
        TE.foldW(
          (errorInfo: { type: string; error?: unknown; entryId: EntryId; eventId: EventId }) =>
            pipe(
              TE.tryCatch(
                async () =>
                  logger.error(
                    { entryId: errorInfo.entryId, eventId: errorInfo.eventId, error: errorInfo },
                    `Failed to process entry event transfer ${errorInfo.entryId} for event ${errorInfo.eventId} during sync: ${errorInfo.type}`,
                  ),
                (err) => {
                  console.error(
                    'CRITICAL: Logging failed during entry event transfer sync error handling',
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

  const syncTransfersFromApi = (eventId: EventId): TE.TaskEither<ServiceError, void> =>
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
    syncTransfersFromApi,
  };
};

export const createEntryEventTransferService = (
  fplDataService: FplTransferDataService,
  repository: EntryEventTransferRepository,
  entryInfoRepository: EntryInfoRepository,
  tournamentEntryRepository: TournamentEntryRepository,
  playerCache: PlayerCache,
  teamCache: TeamCache,
  logger: Logger,
): EntryEventTransferService => {
  const domainOps = createEntryEventTransferOperations(repository);
  const ops = entryEventTransferServiceOperations(
    fplDataService,
    domainOps,
    entryInfoRepository,
    tournamentEntryRepository,
    playerCache,
    teamCache,
    logger,
  );

  return {
    getEntryEventTransfer: (
      id: EntryId,
      eventId: EventId,
    ): TE.TaskEither<ServiceError, EntryEventTransfers> => ops.findByEntryIdAndEventId(id, eventId),
    syncTransfersFromApi: (eventId: EventId): TE.TaskEither<ServiceError, void> =>
      ops.syncTransfersFromApi(eventId),
  };
};
