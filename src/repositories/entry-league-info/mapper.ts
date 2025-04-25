import { LeagueType } from 'src/types/base.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfo } from 'src/types/domain/entry-league-info.type';
import { LeagueId } from 'src/types/domain/league-info.type';

import {
  EntryLeagueInfoCreateInput,
  PrismaEntryLeagueInfo,
  PrismaEntryLeagueInfoCreateInput,
} from './types';

export const mapPrismaEntryLeagueInfoToDomain = (
  prismaEntryLeagueInfo: PrismaEntryLeagueInfo,
): EntryLeagueInfo => ({
  entryId: prismaEntryLeagueInfo.entryId as EntryId,
  leagueId: prismaEntryLeagueInfo.leagueId as LeagueId,
  leagueName: prismaEntryLeagueInfo.leagueName,
  leagueType: prismaEntryLeagueInfo.leagueType as LeagueType,
  startedEvent: prismaEntryLeagueInfo.startedEvent,
  entryRank: prismaEntryLeagueInfo.entryRank,
  entryLastRank: prismaEntryLeagueInfo.entryLastRank,
});

export const mapDomainEntryLeagueInfoToPrismaCreate = (
  domainEntryLeagueInfo: EntryLeagueInfoCreateInput,
): PrismaEntryLeagueInfoCreateInput => ({
  entryId: domainEntryLeagueInfo.entryId,
  leagueId: domainEntryLeagueInfo.leagueId,
  leagueName: domainEntryLeagueInfo.leagueName,
  leagueType: domainEntryLeagueInfo.leagueType,
  startedEvent: domainEntryLeagueInfo.startedEvent,
  entryRank: domainEntryLeagueInfo.entryRank,
  entryLastRank: domainEntryLeagueInfo.entryLastRank,
});
