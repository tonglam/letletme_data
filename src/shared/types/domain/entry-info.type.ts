export type EntryInfo = {
  readonly id: EntryId;
  readonly entryName: string;
  readonly playerName: string;
  readonly region: string | null;
  readonly startedEvent: number;
  readonly overallPoints: number;
  readonly overallRank: number;
  readonly bank: number | null;
  readonly teamValue: number | null;
  readonly totalTransfers: number | null;
  readonly lastEntryName: string | null;
  readonly lastOverallPoints: number | null;
  readonly lastOverallRank: number | null;
  readonly lastTeamValue: number | null;
  readonly usedEntryNames: string[];
};

export type EntryInfos = readonly EntryInfo[];
