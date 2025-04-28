import { createInsertSchema } from 'drizzle-zod';
import { TaskEither } from 'fp-ts/TaskEither';
import * as schema from 'schema/entry-league-info';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfo, EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { LeagueId } from 'types/domain/league.type';
import { DBError } from 'types/error.type';
import { z } from 'zod';

export type DbEntryLeagueInfo = typeof schema.entryLeagueInfos.$inferSelect;
export const DbEntryLeagueInfoCreateSchema = createInsertSchema(schema.entryLeagueInfos);
export type DbEntryLeagueInfoCreateInput = z.infer<typeof DbEntryLeagueInfoCreateSchema>;

export interface EntryLeagueInfoRepository {
  findByEntryId(entryId: EntryId): TaskEither<DBError, EntryLeagueInfos>;
  findByEntryIdAndLeagueId(
    entryId: EntryId,
    leagueId: LeagueId,
  ): TaskEither<DBError, EntryLeagueInfo>;
  upsertEntryLeagueInfo(
    entryLeagueInfoInput: DbEntryLeagueInfoCreateInput,
  ): TaskEither<DBError, EntryLeagueInfo>;
}
