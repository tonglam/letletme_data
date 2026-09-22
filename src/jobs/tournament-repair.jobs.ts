import { randomUUID } from 'node:crypto';

import {
  tournamentRepairQueue,
  tournamentRepairJobId,
  type TournamentRepairJobData,
} from '../queues/tournament-repair.queue';
import { queueRedisSingleton } from '../queues/redis';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { TournamentSetupIssueRecord } from '../domain/tournament-setup-issue';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

export function shouldRescheduleDelayedTournamentRepair(
  existingDueAtMs: number,
  requestedDueAtMs: number,
): boolean {
  return existingDueAtMs > requestedDueAtMs;
}

const TOURNAMENT_REPAIR_ENQUEUE_LEASE_PREFIX =
  'llm:queue:coordination:tournament-repair-enqueue:v1';
const TOURNAMENT_REPAIR_ENQUEUE_LEASE_MS = 30_000;
const TOURNAMENT_REPAIR_ENQUEUE_WAIT_MS = 10_000;
const TOURNAMENT_REPAIR_ENQUEUE_POLL_MS = 100;
const RELEASE_TOURNAMENT_REPAIR_ENQUEUE_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withTournamentRepairEnqueueLease<T>(
  jobId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const redis = await queueRedisSingleton.getClient();
  const key = `${TOURNAMENT_REPAIR_ENQUEUE_LEASE_PREFIX}:${jobId}`;
  const token = randomUUID();
  const deadline = Date.now() + TOURNAMENT_REPAIR_ENQUEUE_WAIT_MS;

  while (Date.now() < deadline) {
    const acquired = await redis.set(
      key,
      token,
      'PX',
      String(TOURNAMENT_REPAIR_ENQUEUE_LEASE_MS),
      'NX',
    );
    if (acquired === 'OK') {
      try {
        return await operation();
      } finally {
        await redis
          .eval(RELEASE_TOURNAMENT_REPAIR_ENQUEUE_LEASE, 1, key, token)
          .catch(() => undefined);
      }
    }
    await sleep(Math.min(TOURNAMENT_REPAIR_ENQUEUE_POLL_MS, deadline - Date.now()));
  }

  throw new Error(`Tournament repair enqueue coordination lease timed out for ${jobId}`);
}

async function readDelayedTournamentRepairDueAt(jobId: string): Promise<number | null> {
  const redis = await tournamentRepairQueue.client;
  const score = await redis.zscore(tournamentRepairQueue.keys.delayed, jobId);
  if (score === null) return null;
  const delayedScore = Number(score);
  if (!Number.isFinite(delayedScore)) return null;
  return Math.floor(delayedScore / 0x1000);
}

export async function enqueueTournamentRepair(
  season: FplSeasonRef,
  issue: TournamentSetupIssueRecord,
  source: TournamentRepairJobData['source'] = 'setup',
) {
  if (await isQueueDrainOnly(tournamentRepairQueue.name)) {
    throw new QueueDrainOnlyError(tournamentRepairQueue.name);
  }
  const jobId = tournamentRepairJobId(season.seasonCode, issue.tournamentId, issue.issueId);
  return withTournamentRepairEnqueueLease(jobId, async () => {
    const now = Date.now();
    const requestedDueAt = Math.max(issue.nextRepairAt?.getTime() ?? now, now);
    const delay = requestedDueAt - now;
    const data: TournamentRepairJobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      tournamentId: issue.tournamentId,
      issueId: issue.issueId,
      triggeredAt: new Date(now).toISOString(),
      source,
    };
    const existing = await tournamentRepairQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'delayed') {
        const existingDueAt = await readDelayedTournamentRepairDueAt(jobId);
        // The lease serializes enqueue decisions for this deterministic job.
        // Read the delayed-set score because Job.delay is only the last
        // relative delay and no longer identifies the current due timestamp
        // after BullMQ changeDelay has been used.
        if (
          existingDueAt !== null &&
          shouldRescheduleDelayedTournamentRepair(existingDueAt, requestedDueAt)
        ) {
          await existing.updateData(data);
          await existing.changeDelay(delay);
        }
        return existing;
      }
      if (['waiting', 'waiting-children', 'active', 'paused'].includes(state)) {
        return existing;
      }
      // The deterministic issue job ID is intentionally reused. Remove an old
      // completed/failed record before the watchdog schedules the next repair;
      // otherwise BullMQ would treat the retained history row as a duplicate
      // forever (the queue retains completed jobs for up to 24 hours).
      await existing.remove();
    }
    return tournamentRepairQueue.add('tournament-repair', data, { jobId, delay });
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
