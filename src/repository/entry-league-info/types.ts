import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { TaskEither } from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-league-info';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfo, EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { LeagueId } from 'types/domain/league.type';
import { DBError } from 'types/error.type';

export type DbEntryLeagueInfo = InferSelectModel<typeof schema.entryLeagueInfos>;
export type DbEntryLeagueInfoCreateInput = InferInsertModel<typeof schema.entryLeagueInfos>;

export type EntryLeagueInfoCreateInput = EntryLeagueInfo;
export type EntryLeagueInfoCreateInputs = readonly EntryLeagueInfoCreateInput[];

export interface EntryLeagueInfoRepository {
  readonly findByEntryId: (entryId: EntryId) => TaskEither<DBError, EntryLeagueInfos>;
  readonly findByEntryIdAndLeagueId: (
    entryId: EntryId,
    leagueId: LeagueId,
  ) => TaskEither<DBError, EntryLeagueInfo>;
  readonly upsertEntryLeagueInfo: (
    entryLeagueInfoInput: DbEntryLeagueInfoCreateInput,
  ) => TaskEither<DBError, EntryLeagueInfo>;
}
