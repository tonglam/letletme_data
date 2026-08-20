export const TOURNAMENT_SETUP_ISSUE_CODES = [
  'ENTRY_PROFILE_INCOMPLETE',
  'ENTRY_HISTORY_INCOMPLETE',
  'LEAGUE_INSIGHTS_INCOMPLETE',
  'SELECTION_INSIGHTS_INCOMPLETE',
  'TOURNAMENT_RESULTS_INCOMPLETE',
  'STRUCTURE_INTEGRITY_FAILED',
] as const;

export type TournamentSetupIssueCode = (typeof TOURNAMENT_SETUP_ISSUE_CODES)[number];

export type TournamentSetupIssueCategory = 'profiles' | 'insights' | 'results';
export type TournamentSetupIssueSeverity = 'warning' | 'blocking';

export type TournamentSetupIssueInput = {
  issueKey: string;
  code: TournamentSetupIssueCode;
  category: TournamentSetupIssueCategory;
  severity: TournamentSetupIssueSeverity;
  eventId?: number | null;
  affectedEntryIds?: number[];
  diagnosticCode?: string | null;
  internalMessage?: string | null;
  nextRepairAt?: Date | null;
};

export type TournamentSetupIssueRecord = TournamentSetupIssueInput & {
  issueId: number;
  seasonId: number;
  tournamentId: number;
  affectedEntryCount: number;
  repairAttempts: number;
  repairExhaustedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
};

export function setupIssueKey(code: TournamentSetupIssueCode, eventId?: number | null): string {
  return `${code}:${eventId ?? 'all'}`;
}

export function dedupeSetupIssueEntries(ids: number[] | undefined): number[] {
  return [...new Set((ids ?? []).filter((id) => Number.isInteger(id) && id > 0))].sort(
    (left, right) => left - right,
  );
}
