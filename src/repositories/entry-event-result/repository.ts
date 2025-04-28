import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryEventResultToPrismaCreate,
  mapPrismaEntryEventResultToDomain,
} from 'src/repositories/entry-event-result/mapper';
import {
  EntryEventResultCreateInputs,
  EntryEventResultRepository,
} from 'src/repositories/entry-event-result/types';
import {
  RawEntryEventResult,
  RawEntryEventResults,
} from 'src/types/domain/entry-event-result.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEntryEventResultRepository = (
  prisma: PrismaClient,
): EntryEventResultRepository => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventResult> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventResult.findUnique({
            where: {
              unique_entry_event_result: { entryId: Number(entryId), eventId: Number(eventId) },
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event result by id ${entryId} and event id ${eventId}: ${error}`,
          }),
      ),
      TE.chainW((prismaEntryEventResultOrNull) =>
        prismaEntryEventResultOrNull
          ? TE.right(mapPrismaEntryEventResultToDomain(prismaEntryEventResultOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Entry event result with ID ${entryId} and event id ${eventId} not found in database`,
              }),
            ),
      ),
    );

  const findByEntryIdsAndEventId = (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventResults> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventResult.findMany({
            where: { entryId: { in: entryIds.map(Number) }, eventId: Number(eventId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event results by entry ids ${entryIds} and event id ${eventId}: ${error}`,
          }),
      ),
      TE.map((prismaEntryEventResults) =>
        prismaEntryEventResults.map(mapPrismaEntryEventResultToDomain),
      ),
    );

  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, RawEntryEventResults> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventResult.findMany({
            where: { entryId: Number(entryId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event results by entry id ${entryId}: ${error}`,
          }),
      ),
      TE.map((prismaEntryEventResults) =>
        prismaEntryEventResults.map(mapPrismaEntryEventResultToDomain),
      ),
    );

  const saveBatchByEntryIdAndEventId = (
    entryEventResultInputs: EntryEventResultCreateInputs,
  ): TE.TaskEither<DBError, RawEntryEventResult> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventResult.createMany({
            data: entryEventResultInputs.map(mapDomainEntryEventResultToPrismaCreate),
            skipDuplicates: true,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry event result: ${error}`,
          }),
      ),
      TE.chain(() =>
        findByEntryIdAndEventId(
          entryEventResultInputs[0].entryId,
          entryEventResultInputs[0].eventId,
        ),
      ),
    );

  return {
    findByEntryIdAndEventId,
    findByEntryIdsAndEventId,
    findByEntryId,
    saveBatchByEntryIdAndEventId,
  };
};
