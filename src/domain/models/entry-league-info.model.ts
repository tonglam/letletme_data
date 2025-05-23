import { LeagueType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { LeagueId } from 'types/domain/league.type';

export type EntryLeagueInfo = {
  readonly entryId: EntryId;
  readonly leagueId: LeagueId;
  readonly leagueName: string;
  readonly leagueType: LeagueType;
  readonly startedEvent: number | null;
  readonly entryRank: number | null;
  readonly entryLastRank: number | null;
};
export type EntryLeagueInfos = readonly EntryLeagueInfo[];
