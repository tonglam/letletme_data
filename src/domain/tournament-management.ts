/**
 * Tournament management policy has no persistence concerns. Keep these
 * decisions in the domain layer so API/service orchestration cannot subtly
 * diverge from the eligibility and ownership rules.
 */

export type TournamentManagementPolicyRecord = Readonly<{
  adminEntryId: number;
  leagueType: string;
  groupMode: string;
  groupNum: number | null;
  knockoutMode: string;
}>;

export type TournamentManagementActor = Readonly<{
  adminEntryId: number;
  platformAdmin: boolean;
}>;

export function canManageTournament(
  tournament: Pick<TournamentManagementPolicyRecord, 'adminEntryId'>,
  actor: TournamentManagementActor,
): boolean {
  return actor.platformAdmin || tournament.adminEntryId === actor.adminEntryId;
}

export function isOfficialRosterSyncEligible(
  tournament: Pick<
    TournamentManagementPolicyRecord,
    'leagueType' | 'groupMode' | 'groupNum' | 'knockoutMode'
  >,
): boolean {
  return (
    tournament.leagueType === 'classic' &&
    tournament.groupMode === 'points_races' &&
    tournament.groupNum === 1 &&
    tournament.knockoutMode === 'no_knockout'
  );
}
