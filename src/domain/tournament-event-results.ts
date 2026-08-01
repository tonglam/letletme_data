export type TournamentEventResultsSummary = {
  totalEntries: number;
};

export function shouldEnqueueTournamentCascade(result: TournamentEventResultsSummary): boolean {
  return result.totalEntries > 0;
}
