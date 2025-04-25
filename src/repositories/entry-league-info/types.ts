import { Prisma, EntryLeagueInfo as PrismaEntryLeagueInfoType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfo } from 'src/types/domain/entry-league-info.type';
import { LeagueId } from 'src/types/domain/league-info.type';
import { DBError } from 'src/types/error.type';

export type PrismaEntryLeagueInfoCreateInput = Prisma.EntryLeagueInfoCreateInput;
export type PrismaEntryLeagueInfo = PrismaEntryLeagueInfoType;

export type EntryLeagueInfoCreateInput = EntryLeagueInfo;

export interface EntryLeagueInfoRepository {
  readonly findByEntryId: (entryId: EntryId) => TE.TaskEither<DBError, EntryLeagueInfo>;
  readonly upsertEntryLeagueInfo: (
    entryLeagueInfoInput: EntryLeagueInfoCreateInput,
  ) => TE.TaskEither<DBError, EntryLeagueInfo>;
  readonly deleteEntryLeagueInfo: (
    entryId: EntryId,
    leagueId: LeagueId,
  ) => TE.TaskEither<DBError, void>;
}
