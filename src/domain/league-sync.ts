import { stableHash } from '../utils/stable-hash';

export function leagueChildJobId(
  jobName: string,
  eventId: number,
  tournamentId: number,
  runId?: string,
): string {
  const runKey = stableHash(runId ?? `${jobName}-manual`);
  return `${jobName}-e${eventId}-t${tournamentId}-c${runKey}`;
}
