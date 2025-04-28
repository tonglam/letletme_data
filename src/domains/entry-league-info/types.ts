import * as TE from 'fp-ts/TaskEither';
import { EntryLeagueInfoCreateInput } from 'repositories/entry-league-info/types';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfo, EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { DomainError } from 'types/error.type';

export interface EntryLeagueInfoOperations {
  readonly findByEntryId: (id: EntryId) => TE.TaskEither<DomainError, EntryLeagueInfos>;
  readonly upsertEntryLeagueInfo: (
    entryLeagueInfoInput: EntryLeagueInfoCreateInput,
  ) => TE.TaskEither<DomainError, EntryLeagueInfo>;
}
