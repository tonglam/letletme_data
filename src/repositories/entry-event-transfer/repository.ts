import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryEventTransferToPrismaCreate,
  mapPrismaEntryEventTransferToDomain,
} from 'src/repositories/entry-event-transfer/mapper';
import {
  EntryEventTransferCreateInputs,
  EntryEventTransferRepository,
} from 'src/repositories/entry-event-transfer/types';
import { RawEntryEventTransfers } from 'src/types/domain/entry-event-transfer.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEntryEventTransferRepository = (
  prisma: PrismaClient,
): EntryEventTransferRepository => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventTransfers> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventTransfer.findMany({
            where: {
              entryId: Number(entryId),
              eventId: Number(eventId),
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event transfer by id ${entryId} and event id ${eventId}: ${error}`,
          }),
      ),
      TE.chainW((prismaEntryEventTransfers) =>
        prismaEntryEventTransfers
          ? TE.right(prismaEntryEventTransfers.map(mapPrismaEntryEventTransferToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Entry event transfer with ID ${entryId} and event id ${eventId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByEntryIdAndEventId = (
    entryEventTransferInputs: EntryEventTransferCreateInputs,
  ): TE.TaskEither<DBError, RawEntryEventTransfers> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryEventTransfer.createMany({
            data: entryEventTransferInputs.map(mapDomainEntryEventTransferToPrismaCreate),
            skipDuplicates: true,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry event transfer: ${error}`,
          }),
      ),
      TE.chain(() =>
        findByEntryIdAndEventId(
          entryEventTransferInputs[0].entryId,
          entryEventTransferInputs[0].eventId,
        ),
      ),
    );

  return {
    findByEntryIdAndEventId,
    saveBatchByEntryIdAndEventId,
  };
};
