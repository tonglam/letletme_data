import { db } from 'db/index';
import { and, eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryEventTransferToDbCreate,
  mapDbEntryEventTransferToDomain,
} from 'repository/entry-event-transfer/mapper';
import {
  EntryEventTransferCreateInputs,
  EntryEventTransferRepository,
} from 'repository/entry-event-transfer/types';
import * as schema from 'schema/entry-event-transfer';
import { RawEntryEventTransfers } from 'types/domain/entry-event-transfer.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryEventTransferRepository = (): EntryEventTransferRepository => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventTransfers> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryEventTransfers)
            .where(
              and(
                eq(schema.entryEventTransfers.entryId, Number(entryId)),
                eq(schema.entryEventTransfers.eventId, Number(eventId)),
              ),
            );
          return result.map(mapDbEntryEventTransferToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event transfer by id ${entryId} and event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByEntryIdAndEventId = (
    entryEventTransferInputs: EntryEventTransferCreateInputs,
  ): TE.TaskEither<DBError, RawEntryEventTransfers> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db
            .insert(schema.entryEventTransfers)
            .values(entryEventTransferInputs.map(mapDomainEntryEventTransferToDbCreate))
            .onConflictDoNothing({
              target: [schema.entryEventTransfers.entryId, schema.entryEventTransfers.eventId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry event transfer: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
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
