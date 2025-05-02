import * as TE from 'fp-ts/TaskEither';
import { EntryLeagueInfoCreateInputs } from 'repository/entry-league-info/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { DomainError } from 'types/error.type';

export interface EntryLeagueInfoOperations {
  readonly findByEntryId: (id: EntryId) => TE.TaskEither<DomainError, EntryLeagueInfos>;
  readonly upsertEntryLeagueInfoBatch: (
    entryLeagueInfoInputs: EntryLeagueInfoCreateInputs,
  ) => TE.TaskEither<DomainError, EntryLeagueInfos>;
}
