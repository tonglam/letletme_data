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

export function shouldPreserveBullmqRetryDelay(
  attemptsMade: number,
  attemptsStarted: number,
): boolean {
  return attemptsMade > 0 || attemptsStarted > 0;
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
const RENEW_TOURNAMENT_REPAIR_ENQUEUE_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;
// Keep the retry-state read, lease fence, delayed-score comparison, and
// reschedule mutation in one Redis operation. A BullMQ worker may move the
// job between delayed and active/retry state while JavaScript is awaiting a
// read, so separate calls could either erase retry backoff or let an expired
// enqueue lease mutate the job.
const RESCHEDULE_TOURNAMENT_REPAIR_LUA = `
local rcall = redis.call

if rcall('GET', KEYS[1]) ~= ARGV[1] then return {-2} end
if rcall('EXISTS', KEYS[2]) ~= 1 then return {-1} end

local delayedScore = rcall('ZSCORE', KEYS[3], ARGV[2])
if not delayedScore then return {-3} end

local attemptsMade = tonumber(rcall('HGET', KEYS[2], 'atm') or '0') or 0
local attemptsStarted = tonumber(rcall('HGET', KEYS[2], 'ats') or '0') or 0
if attemptsMade > 0 or attemptsStarted > 0 then return {0} end

local requestedDueAt = tonumber(ARGV[3])
if not requestedDueAt then return {-4} end
local existingDueAt = math.floor(tonumber(delayedScore) / 0x1000)
if existingDueAt <= requestedDueAt then return {0, existingDueAt} end

local time = rcall('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local delay = math.max(0, requestedDueAt - now)
local delayedTimestamp = (delay > 0 and (now + delay)) or now
local minScore = delayedTimestamp * 0x1000
local maxScore = (delayedTimestamp + 1) * 0x1000 - 1
local current = rcall('ZREVRANGEBYSCORE', KEYS[3], maxScore, minScore, 'WITHSCORES', 'LIMIT', 0, 1)
local score = minScore
if #current then
  local currentMaxScore = tonumber(current[2])
  if currentMaxScore ~= nil then
    if currentMaxScore >= maxScore then
      score = maxScore
    else
      score = currentMaxScore + 1
    end
  end
end

local removed = rcall('ZREM', KEYS[3], ARGV[2])
if removed < 1 then return {-3} end
rcall('HSET', KEYS[2], 'data', ARGV[4], 'delay', delay)
rcall('ZADD', KEYS[3], score, ARGV[2])

local maxEvents = rcall('HGET', KEYS[5], 'opts.maxLenEvents')
if not maxEvents then
  maxEvents = 10000
  rcall('HSET', KEYS[5], 'opts.maxLenEvents', maxEvents)
end
rcall('XADD', KEYS[6], 'MAXLEN', '~', maxEvents, '*', 'event', 'delayed', 'jobId', ARGV[2], 'delay', delayedTimestamp)

local nextDelayed = rcall('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')
if #nextDelayed then
  local nextTimestamp = tonumber(nextDelayed[2])
  if nextTimestamp ~= nil then
    rcall('ZADD', KEYS[4], nextTimestamp / 0x1000, '1')
  end
end

return {1, delay}
`;

type TournamentRepairEnqueueLease = {
  redis: Awaited<ReturnType<typeof queueRedisSingleton.getClient>>;
  key: string;
  token: string;
  assertLease: () => Promise<void>;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withTournamentRepairEnqueueLease<T>(
  jobId: string,
  operation: (lease: TournamentRepairEnqueueLease) => Promise<T>,
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
      let renewalInFlight = false;
      let lostError: Error | null = null;
      const markLost = () => {
        lostError ??= new Error(`Tournament repair enqueue lease lost for ${jobId}`);
      };
      const assertLease = async (): Promise<void> => {
        if (lostError) throw lostError;
        try {
          if ((await redis.get(key)) !== token) markLost();
        } catch {
          markLost();
        }
        if (lostError) throw lostError;
      };
      const renewLease = async (): Promise<void> => {
        if (renewalInFlight || lostError) return;
        renewalInFlight = true;
        try {
          const renewed = await redis.eval(
            RENEW_TOURNAMENT_REPAIR_ENQUEUE_LEASE,
            1,
            key,
            token,
            String(TOURNAMENT_REPAIR_ENQUEUE_LEASE_MS),
          );
          if (Number(renewed) !== 1) markLost();
        } catch {
          markLost();
        } finally {
          renewalInFlight = false;
        }
      };
      const renewalTimer = setInterval(
        () => void renewLease(),
        Math.max(250, Math.floor(TOURNAMENT_REPAIR_ENQUEUE_LEASE_MS / 3)),
      );
      renewalTimer.unref?.();
      try {
        await assertLease();
        return await operation({ redis, key, token, assertLease });
      } finally {
        clearInterval(renewalTimer);
        await redis
          .eval(RELEASE_TOURNAMENT_REPAIR_ENQUEUE_LEASE, 1, key, token)
          .catch(() => undefined);
      }
    }
    await sleep(Math.min(TOURNAMENT_REPAIR_ENQUEUE_POLL_MS, deadline - Date.now()));
  }

  throw new Error(`Tournament repair enqueue coordination lease timed out for ${jobId}`);
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
  return withTournamentRepairEnqueueLease(jobId, async (lease) => {
    const { assertLease } = lease;
    const assertQueueAdmission = async (): Promise<void> => {
      await assertLease();
      if (await isQueueDrainOnly(tournamentRepairQueue.name)) {
        throw new QueueDrainOnlyError(tournamentRepairQueue.name);
      }
      await assertLease();
    };
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
    await assertLease();
    const existing = await tournamentRepairQueue.getJob(jobId);
    await assertLease();
    if (existing) {
      const state = await existing.getState();
      if (state === 'delayed') {
        if (shouldPreserveBullmqRetryDelay(existing.attemptsMade, existing.attemptsStarted)) {
          return existing;
        }
        await assertQueueAdmission();
        const result = (await lease.redis.eval(
          RESCHEDULE_TOURNAMENT_REPAIR_LUA,
          6,
          lease.key,
          tournamentRepairQueue.toKey(jobId),
          tournamentRepairQueue.keys.delayed,
          tournamentRepairQueue.keys.marker,
          tournamentRepairQueue.keys.meta,
          tournamentRepairQueue.keys.events,
          lease.token,
          jobId,
          String(requestedDueAt),
          JSON.stringify(data),
        )) as Array<string | number>;
        const resultCode = Number(result[0]);
        if (resultCode === -2) {
          await assertLease();
          throw new Error(`Tournament repair reschedule was fenced for ${jobId}`);
        }
        if (resultCode === 1) {
          existing.data = data;
          existing.delay = Number(result[1]);
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
      await assertQueueAdmission();
      await existing.remove();
    }
    await assertQueueAdmission();
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
