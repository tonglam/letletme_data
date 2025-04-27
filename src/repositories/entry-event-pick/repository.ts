import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryEventPickToPrismaCreate,
  mapPrismaEntryEventPickToDomain,
} from 'src/repositories/entry-event-pick/mapper';
import {
  EntryEventPickCreateInputs,
  EntryEventPickRepository,
} from 'src/repositories/entry-event-pick/types';
import { RawEntryEventPick } from 'src/types/domain/entry-event-pick.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEntryEventPickRepository = (prisma: PrismaClient): EntryEventPickRepository => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventPick> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventPick.findUnique({
            where: {
              unique_entry_event_pick: { entryId: Number(entryId), eventId: Number(eventId) },
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event pick by id ${entryId} and event id ${eventId}: ${error}`,
          }),
      ),
      TE.chainW((prismaEntryEventPickOrNull) =>
        prismaEntryEventPickOrNull
          ? TE.right(mapPrismaEntryEventPickToDomain(prismaEntryEventPickOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Entry event pick with ID ${entryId} and event id ${eventId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByEntryIdAndEventId = (
    entryEventPickInputs: EntryEventPickCreateInputs,
  ): TE.TaskEither<DBError, RawEntryEventPick> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventPick.createMany({
            data: entryEventPickInputs.map(mapDomainEntryEventPickToPrismaCreate),
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry event pick: ${error}`,
          }),
      ),
      TE.chain(() =>
        findByEntryIdAndEventId(entryEventPickInputs[0].entryId, entryEventPickInputs[0].eventId),
      ),
    );

  return {
    findByEntryIdAndEventId,
    saveBatchByEntryIdAndEventId,
  };
};
