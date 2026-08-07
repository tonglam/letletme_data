export type FplSeasonArchiveStatus = 'unavailable' | 'pending' | 'building' | 'sealed' | 'failed';

export interface FplSeasonArchive {
  season: string;
  status: FplSeasonArchiveStatus;
  reason: string | null;
  sourceCoreRevision: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorSummary: string | null;
}

export interface FplSeasonArchiveItem {
  season: string;
  sourceTable: string;
  archiveTable: string;
  rowCount: number;
  canonicalChecksum: string;
  verifiedAt: Date;
}

export type FplSeasonDataLocation =
  | { kind: 'current'; season: string }
  | { kind: 'archive'; season: string }
  | { kind: 'unavailable'; season: string; reason: string };
