import { db } from 'db/index';
import { eq, and } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryEventPickToDbCreate,
  mapDbEntryEventPickToDomain,
} from 'repository/entry-event-pick/mapper';
import {
  EntryEventPickCreateInputs,
  EntryEventPickRepository,
} from 'repository/entry-event-pick/types';
import * as schema from 'schema/entry-event-pick';
import { RawEntryEventPick } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryEventPickRepository = (): EntryEventPickRepository => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventPick> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryEventPicks)
            .where(
              and(
                eq(schema.entryEventPicks.entryId, Number(entryId)),
                eq(schema.entryEventPicks.eventId, Number(eventId)),
              ),
            );
          return mapDbEntryEventPickToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event pick by id ${entryId} and event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByEntryIdAndEventId = (
    entryEventPickInputs: EntryEventPickCreateInputs,
  ): TE.TaskEither<DBError, RawEntryEventPick> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db
            .insert(schema.entryEventPicks)
            .values(entryEventPickInputs.map(mapDomainEntryEventPickToDbCreate))
            .onConflictDoNothing({
              target: [schema.entryEventPicks.entryId, schema.entryEventPicks.eventId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry event pick: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
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
