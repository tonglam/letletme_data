import { db } from 'db/index';
import { and, eq, inArray } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryEventResultToDbCreate,
  mapDbEntryEventResultToDomain,
} from 'repository/entry-event-result/mapper';
import {
  EntryEventResultCreateInputs,
  EntryEventResultRepository,
} from 'repository/entry-event-result/types';
import * as schema from 'schema/entry-event-result.schema';
import { RawEntryEventResult, RawEntryEventResults } from 'types/domain/entry-event-result.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryEventResultRepository = (): EntryEventResultRepository => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventResult> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryEventResults)
            .where(
              and(
                eq(schema.entryEventResults.entryId, Number(entryId)),
                eq(schema.entryEventResults.eventId, Number(eventId)),
              ),
            );
          return mapDbEntryEventResultToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event result by id ${entryId} and event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByEntryIdsAndEventId = (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ): TE.TaskEither<DBError, RawEntryEventResults> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryEventResults)
            .where(
              and(
                inArray(schema.entryEventResults.entryId, entryIds.map(Number)),
                eq(schema.entryEventResults.eventId, Number(eventId)),
              ),
            );
          return result.map(mapDbEntryEventResultToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event results by entry ids ${entryIds} and event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, RawEntryEventResults> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryEventResults)
            .where(eq(schema.entryEventResults.entryId, Number(entryId)));
          return result.map(mapDbEntryEventResultToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry event results by entry id ${entryId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByEntryIdAndEventId = (
    entryEventResultInputs: EntryEventResultCreateInputs,
  ): TE.TaskEither<DBError, RawEntryEventResult> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db
            .insert(schema.entryEventResults)
            .values(entryEventResultInputs.map(mapDomainEntryEventResultToDbCreate))
            .onConflictDoNothing({
              target: [schema.entryEventResults.entryId, schema.entryEventResults.eventId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry event result: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
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
