import { EntryId, EntryInfo } from 'src/types/domain/entry-info.type';

import { EntryInfoCreateInput, PrismaEntryInfo, PrismaEntryInfoCreateInput } from './types';

export const mapPrismaEntryInfoToDomain = (prismaEntryInfo: PrismaEntryInfo): EntryInfo => ({
  id: prismaEntryInfo.id as EntryId,
  entryName: prismaEntryInfo.entryName,
  playerName: prismaEntryInfo.playerName,
  region: prismaEntryInfo.region,
  startedEvent: prismaEntryInfo.startedEvent ?? 0,
  overallPoints: prismaEntryInfo.overallPoints ?? 0,
  overallRank: prismaEntryInfo.overallRank ?? 0,
  bank: prismaEntryInfo.bank ?? 0,
  teamValue: prismaEntryInfo.teamValue ?? 0,
  totalTransfers: prismaEntryInfo.totalTransfers ?? 0,
  lastEntryName: prismaEntryInfo.lastEntryName,
  lastOverallPoints: prismaEntryInfo.lastOverallPoints,
  lastOverallRank: prismaEntryInfo.lastOverallRank,
  lastEventPoints: prismaEntryInfo.lastEventPoints,
  lastTeamValue: prismaEntryInfo.lastTeamValue,
  usedEntryNames: prismaEntryInfo.usedEntryNames,
});

export const mapDomainEntryInfoToPrismaCreate = (
  domainEntryInfo: EntryInfoCreateInput,
): PrismaEntryInfoCreateInput => ({
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
  lastEventPoints: domainEntryInfo.lastEventPoints,
  lastTeamValue: domainEntryInfo.lastTeamValue,
  usedEntryNames: domainEntryInfo.usedEntryNames,
});
