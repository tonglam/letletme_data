import { EntryHistoryInfoOperations } from 'domain/entry-history-info/types';

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  EntryHistoryInfoCreateInputs,
  EntryHistoryInfoRepository,
} from 'repository/entry-history-info/types';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { createDomainError, DomainError, DomainErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryHistoryInfoOperations = (
  repository: EntryHistoryInfoRepository,
): EntryHistoryInfoOperations => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DomainError, EntryHistoryInfos> =>
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

  const findAllEntryIds = (): TE.TaskEither<DomainError, ReadonlyArray<EntryId>> =>
    pipe(
      repository.findAllEntryIds(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findAllEntryIds): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const saveBatchByEntryId = (
    entryHistoryInfoInputs: EntryHistoryInfoCreateInputs,
  ): TE.TaskEither<DomainError, EntryHistoryInfos> =>
    pipe(
      repository.saveBatchByEntryId(entryHistoryInfoInputs),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatchByEntryId): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    findByEntryId,
    findAllEntryIds,
    saveBatchByEntryId,
  };
};
