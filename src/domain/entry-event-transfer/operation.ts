import { EntryEventTransferOperations } from 'domain/entry-event-transfer/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  EntryEventTransferCreateInputs,
  EntryEventTransferRepository,
} from 'repository/entry-event-transfer/types';
import { RawEntryEventTransfers } from 'types/domain/entry-event-transfer.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryEventTransferOperations = (
  repository: EntryEventTransferRepository,
): EntryEventTransferOperations => {
  const findByEntryIdAndEventId = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DomainError, RawEntryEventTransfers> =>
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
    entryEventTransferInputs: EntryEventTransferCreateInputs,
  ): TE.TaskEither<DomainError, RawEntryEventTransfers> =>
    pipe(
      repository.saveBatchByEntryIdAndEventId(entryEventTransferInputs),
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
    saveBatchByEntryIdAndEventId,
  };
};
