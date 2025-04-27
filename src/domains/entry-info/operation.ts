import { EntryInfoOperations } from 'domains/entry-info/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { EntryInfoRepository } from '../../repositories/entry-info/types';
import { EntryId, EntryInfo, EntryInfos } from '../../types/domain/entry-info.type';
import { createDomainError, DomainError, DomainErrorCode } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createEntryInfoOperations = (repository: EntryInfoRepository): EntryInfoOperations => {
  const findById = (id: EntryId): TE.TaskEither<DomainError, EntryInfo> =>
    pipe(
      repository.findById(id),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findById): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const findByIds = (entryIds: ReadonlyArray<EntryId>): TE.TaskEither<DomainError, EntryInfos> =>
    pipe(
      repository.findByIds(entryIds),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findByEntryIds): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  const upsertEntryInfo = (entryInfo: EntryInfo): TE.TaskEither<DomainError, EntryInfo> =>
    pipe(
      repository.upsertEntryInfo(entryInfo),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (upsertEntryInfo): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    );

  return {
    findById,
    findByIds,
    upsertEntryInfo,
  };
};
