import {
  EntryInfoCreateInput,
  DbEntryInfo,
  DbEntryInfoCreateInput,
} from 'repositories/entry-info/types';
import { EntryId, EntryInfo } from 'types/domain/entry-info.type';

export const mapDbEntryInfoToDomain = (dbEntryInfo: DbEntryInfo): EntryInfo => ({
  id: dbEntryInfo.id as EntryId,
  entryName: dbEntryInfo.entryName,
  playerName: dbEntryInfo.playerName,
  region: dbEntryInfo.region,
  startedEvent: dbEntryInfo.startedEvent ?? 0,
  overallPoints: dbEntryInfo.overallPoints ?? 0,
  overallRank: dbEntryInfo.overallRank ?? 0,
  bank: dbEntryInfo.bank ?? 0,
  teamValue: dbEntryInfo.teamValue ?? 0,
  totalTransfers: dbEntryInfo.totalTransfers ?? 0,
  lastEntryName: dbEntryInfo.lastEntryName,
  lastOverallPoints: dbEntryInfo.lastOverallPoints ?? 0,
  lastOverallRank: dbEntryInfo.lastOverallRank ?? 0,
  lastTeamValue: dbEntryInfo.lastTeamValue ?? 0,
  usedEntryNames: dbEntryInfo.usedEntryNames ?? [],
});

export const mapDomainEntryInfoToDbCreate = (
  domainEntryInfo: EntryInfoCreateInput,
): DbEntryInfoCreateInput => ({
  id: domainEntryInfo.id,
  entryName: domainEntryInfo.entryName,
  playerName: domainEntryInfo.playerName,
  region: domainEntryInfo.region,
  startedEvent: domainEntryInfo.startedEvent,
  overallPoints: domainEntryInfo.overallPoints,
  overallRank: domainEntryInfo.overallRank,
  bank: domainEntryInfo.bank,
  teamValue: domainEntryInfo.teamValue,
  totalTransfers: domainEntryInfo.totalTransfers,
  lastEntryName: domainEntryInfo.lastEntryName,
  lastOverallPoints: domainEntryInfo.lastOverallPoints,
  lastOverallRank: domainEntryInfo.lastOverallRank,
  lastTeamValue: domainEntryInfo.lastTeamValue,
  usedEntryNames: domainEntryInfo.usedEntryNames,
});
