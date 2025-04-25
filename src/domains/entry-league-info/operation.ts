import { EntryLeagueInfoOperations } from 'domains/entry-league-info/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EntryLeagueInfo, EntryLeagueInfos } from 'src/types/domain/entry-league-info.type';

import {
  EntryLeagueInfoCreateInput,
  EntryLeagueInfoRepository,
} from '../../repositories/entry-league-info/types';
import { EntryId } from '../../types/domain/entry-info.type';
import { createDomainError, DomainError, DomainErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createEntryLeagueInfoOperations = (
  repository: EntryLeagueInfoRepository,
): EntryLeagueInfoOperations => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DomainError, EntryLeagueInfos> =>
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

  const upsertEntryLeagueInfo = (
    entryLeagueInfoInput: EntryLeagueInfoCreateInput,
  ): TE.TaskEither<DomainError, EntryLeagueInfo> =>
    pipe(
      repository.upsertEntryLeagueInfo(entryLeagueInfoInput),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (upsertEntryLeagueInfo): ${getErrorMessage(dbError)}`,
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
    findByEntryId,
    upsertEntryLeagueInfo,
    deleteByEntryId,
  };
};
