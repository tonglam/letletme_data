import {
  tournamentRepairQueue,
  tournamentRepairJobId,
  type TournamentRepairJobData,
} from '../queues/tournament-repair.queue';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { TournamentSetupIssueRecord } from '../domain/tournament-setup-issue';

export async function enqueueTournamentRepair(
  season: FplSeasonRef,
  issue: TournamentSetupIssueRecord,
  source: TournamentRepairJobData['source'] = 'setup',
) {
  const data: TournamentRepairJobData = {
    seasonId: season.seasonId,
    seasonCode: season.seasonCode,
    tournamentId: issue.tournamentId,
    issueId: issue.issueId,
    triggeredAt: new Date().toISOString(),
    source,
  };
  const jobId = tournamentRepairJobId(season.seasonCode, issue.tournamentId, issue.issueId);
  const existing = await tournamentRepairQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (['waiting', 'waiting-children', 'delayed', 'active', 'paused'].includes(state)) {
      return existing;
    }
    // The deterministic issue job ID is intentionally reused. Remove an old
    // completed/failed record before the watchdog schedules the next repair;
    // otherwise BullMQ would treat the retained history row as a duplicate
    // forever (the queue retains completed jobs for up to 24 hours).
    await existing.remove();
  }
  return tournamentRepairQueue.add('tournament-repair', data, {
    jobId,
    delay: issue.nextRepairAt ? Math.max(0, issue.nextRepairAt.getTime() - Date.now()) : 0,
  });
}

export async function cancelTournamentRepairJobs(tournamentId: number): Promise<number> {
  let removed = 0;
  const jobs = await tournamentRepairQueue.getJobs(['waiting', 'delayed', 'paused']);
  for (const job of jobs) {
    if (job.data.tournamentId !== tournamentId) continue;
    await job.remove().catch(() => undefined);
    removed += 1;
  }
  return removed;
}
