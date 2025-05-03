import {
  EntryHistoryInfoCreateInput,
  DbEntryHistoryInfo,
  DbEntryHistoryInfoCreateInput,
} from 'repository/entry-history-info/types';
import { EntryHistoryInfo } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { Season } from 'utils/common.util';

export const mapDbEntryHistoryInfoToDomain = (
  dbEntryHistoryInfo: DbEntryHistoryInfo,
): EntryHistoryInfo => ({
  entryId: dbEntryHistoryInfo.entryId as EntryId,
  season: dbEntryHistoryInfo.season as Season,
  totalPoints: dbEntryHistoryInfo.totalPoints as number,
  overallRank: dbEntryHistoryInfo.overallRank as number,
});

export const mapDomainEntryHistoryInfoToDbCreate = (
  domainEntryHistoryInfo: EntryHistoryInfoCreateInput,
): DbEntryHistoryInfoCreateInput => ({
  entryId: domainEntryHistoryInfo.entryId,
  season: domainEntryHistoryInfo.season,
  totalPoints: domainEntryHistoryInfo.totalPoints,
  overallRank: domainEntryHistoryInfo.overallRank,
});
