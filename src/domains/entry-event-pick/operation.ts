import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  EntryEventPickCreateInputs,
  EntryEventPickRepository,
} from 'src/repositories/entry-event-pick/types';
import { RawEntryEventPick } from 'src/types/domain/entry-event-pick.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';

import { EntryEventPickOperations } from './types';
import { createDomainError, DomainError, DomainErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createEntryEventPickOperations = (
  repository: EntryEventPickRepository,
): EntryEventPickOperations => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DomainError, RawEntryEventPick> =>
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

  const saveBatchByEntryIdAndEventId = (
    entryEventPickInputs: EntryEventPickCreateInputs,
  ): TE.TaskEither<DomainError, RawEntryEventPick> =>
    pipe(
      repository.saveBatchByEntryIdAndEventId(entryEventPickInputs),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatchByEntryIdAndEventId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const deleteByEntryId = (entryId: EntryId): TE.TaskEither<DomainError, void> =>
    pipe(
      repository.deleteByEntryId(entryId),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteByEntryId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    findByEntryIdAndEventId,
    saveBatchByEntryIdAndEventId,
    deleteByEntryId,
  };
};
