import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  EntryHistoryInfoCreateInputs,
  EntryHistoryInfoRepository,
} from 'src/repositories/entry-history-info/types';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { EntryId } from 'src/types/domain/entry-info.type';

import { EntryHistoryInfoOperations } from './types';
import { createDomainError, DomainError, DomainErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

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
    saveBatchByEntryId,
  };
};
