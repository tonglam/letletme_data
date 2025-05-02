import { EntryEventResultOperations } from 'domain/entry-event-result/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  EntryEventResultCreateInputs,
  EntryEventResultRepository,
} from 'repository/entry-event-result/types';
import { RawEntryEventResult, RawEntryEventResults } from 'types/domain/entry-event-result.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryEventResultOperations = (
  repository: EntryEventResultRepository,
): EntryEventResultOperations => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DomainError, RawEntryEventResult> =>
    pipe(
      repository.findByEntryIdAndEventId(entryId, eventId),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findByEntryIdAndEventId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const findByEntryIdsAndEventId = (
    entryIds: ReadonlyArray<EntryId>,
    eventId: EventId,
  ): TE.TaskEither<DomainError, RawEntryEventResults> =>
    pipe(
      repository.findByEntryIdsAndEventId(entryIds, eventId),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findByEntryIdsAndEventId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const findByEntryId = (entryId: EntryId): TE.TaskEither<DomainError, RawEntryEventResults> =>
    pipe(
      repository.findByEntryId(entryId),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findByEntryId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const saveBatchByEntryIdAndEventId = (
    entryEventResultInputs: EntryEventResultCreateInputs,
  ): TE.TaskEither<DomainError, RawEntryEventResult> =>
    pipe(
      repository.saveBatchByEntryIdAndEventId(entryEventResultInputs),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatchByEntryIdAndEventId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    findByEntryIdAndEventId,
    findByEntryIdsAndEventId,
    findByEntryId,
    saveBatchByEntryIdAndEventId,
  };
};
