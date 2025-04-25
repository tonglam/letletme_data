import { EntryHistoryInfo } from 'src/types/domain/entry-history-info.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { Season } from 'src/utils/common.util';

import {
  EntryHistoryInfoCreateInput,
  PrismaEntryHistoryInfo,
  PrismaEntryHistoryInfoCreateInput,
} from './types';

export const mapPrismaEntryHistoryInfoToDomain = (
  prismaEntryHistoryInfo: PrismaEntryHistoryInfo,
): EntryHistoryInfo => ({
  entryId: prismaEntryHistoryInfo.entryId as EntryId,
  season: prismaEntryHistoryInfo.season as Season,
  totalPoints: prismaEntryHistoryInfo.totalPoints as number,
  overallRank: prismaEntryHistoryInfo.overallRank as number,
});

export const mapDomainEntryHistoryInfoToPrismaCreate = (
  domainEntryHistoryInfo: EntryHistoryInfoCreateInput,
): PrismaEntryHistoryInfoCreateInput => ({
  entryId: domainEntryHistoryInfo.entryId,
  season: domainEntryHistoryInfo.season,
  totalPoints: domainEntryHistoryInfo.totalPoints,
  overallRank: domainEntryHistoryInfo.overallRank,
});
