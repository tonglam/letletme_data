import {
  EntryLeagueInfoCreateInput,
  DbEntryLeagueInfo,
  DbEntryLeagueInfoCreateInput,
} from 'repositories/entry-league-info/types';
import { LeagueType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfo } from 'types/domain/entry-league-info.type';
import { LeagueId } from 'types/domain/league.type';

export const mapDbEntryLeagueInfoToDomain = (
  dbEntryLeagueInfo: DbEntryLeagueInfo,
): EntryLeagueInfo => ({
  entryId: dbEntryLeagueInfo.entryId as EntryId,
  leagueId: dbEntryLeagueInfo.leagueId as LeagueId,
  leagueName: dbEntryLeagueInfo.leagueName,
  leagueType: dbEntryLeagueInfo.leagueType as LeagueType,
  startedEvent: dbEntryLeagueInfo.startedEvent,
  entryRank: dbEntryLeagueInfo.entryRank,
  entryLastRank: dbEntryLeagueInfo.entryLastRank,
});

export const mapDomainEntryLeagueInfoToDbCreate = (
  domainEntryLeagueInfo: EntryLeagueInfoCreateInput,
): DbEntryLeagueInfoCreateInput => ({
  entryId: domainEntryLeagueInfo.entryId,
  leagueId: domainEntryLeagueInfo.leagueId,
  leagueName: domainEntryLeagueInfo.leagueName,
  leagueType:
    domainEntryLeagueInfo.leagueType as unknown as DbEntryLeagueInfoCreateInput['leagueType'],
  startedEvent: domainEntryLeagueInfo.startedEvent,
  entryRank: domainEntryLeagueInfo.entryRank,
  entryLastRank: domainEntryLeagueInfo.entryLastRank,
});
