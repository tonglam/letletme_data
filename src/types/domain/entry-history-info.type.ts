import { EntryId } from 'src/types/domain/entry-info.type';

export type EntryHistoryInfo = {
  readonly entryId: EntryId;
  readonly season: string;
  readonly totalPoints: number;
  readonly overallRank: number;
};

export type EntryHistoryInfos = readonly EntryHistoryInfo[];
