import 'dotenv/config';

import type { Job, Queue } from 'bullmq';
import { and, asc, eq, gte, lte } from 'drizzle-orm';

import { events } from '../src/db/schemas/index.schema';
import { getDb } from '../src/db/singleton';
import { enqueueEntryResultsSyncJob } from '../src/jobs/entry-sync-enqueue';
import { enqueueLeagueEventResults } from '../src/jobs/league-sync.jobs';
import { enqueueTournamentEventResults } from '../src/jobs/tournament-sync.jobs';
import { closeEntrySyncQueue, entrySyncQueuesByTier } from '../src/queues/entry-sync.queue';
import { closeLeagueSyncQueue, leagueSyncQueuesByTier } from '../src/queues/league-sync.queue';
import {
  closeTournamentSyncQueue,
  TOURNAMENT_JOBS,
  tournamentSyncQueuesByTier,
} from '../src/queues/tournament-sync.queue';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STAGE_TIMEOUT_MS = 45 * 60_000;
const TOURNAMENT_BACKFILL_JOB_NAMES = new Set<string>([
  TOURNAMENT_JOBS.EVENT_RESULTS,
  TOURNAMENT_JOBS.POINTS_RACE,
  TOURNAMENT_JOBS.BATTLE_RACE,
  TOURNAMENT_JOBS.KNOCKOUT,
  TOURNAMENT_JOBS.CUP_RESULTS,
]);

type QueueJobData = {
  eventId?: number;
};

function parseIntArg(name: string): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) {
    return undefined;
  }

  const value = Number(raw.split('=').slice(1).join('='));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid --${name} value: ${raw}`);
  }
  return value;
}

function parseDurationArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!raw) {
    return fallback;
  }

  const value = Number(raw.split('=').slice(1).join('='));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --${name} value: ${raw}`);
  }
  return Math.floor(value);
}

function collectUniqueQueues(
  queuesByTier: Record<'p0' | 'p1' | 'p2' | 'p3', Queue<unknown>>,
): Queue<unknown>[] {
  const byName = new Map<string, Queue<unknown>>();
  for (const queue of Object.values(queuesByTier)) {
    if (!byName.has(queue.name)) {
      byName.set(queue.name, queue);
    }
  }
  return Array.from(byName.values());
}

function getEventIdFromJob(job: Job<unknown>): number | undefined {
  const data = job.data as QueueJobData | undefined;
  return data?.eventId;
}

async function countMatchingJobs(
  queues: readonly Queue<unknown>[],
  eventId: number,
  allowedJobNames: ReadonlySet<string>,
  states: ('waiting' | 'active' | 'delayed' | 'prioritized' | 'waiting-children')[],
): Promise<number> {
  let total = 0;
  for (const queue of queues) {
    const jobs = await queue.getJobs(states, 0, 5_000, false);
    total += jobs.filter((job) => {
      if (!allowedJobNames.has(job.name)) {
        return false;
      }
      return getEventIdFromJob(job) === eventId;
    }).length;
  }
  return total;
}

async function countRecentFailures(
  queues: readonly Queue<unknown>[],
  eventId: number,
  allowedJobNames: ReadonlySet<string>,
  stageStartedAtMs: number,
): Promise<number> {
  let total = 0;
  for (const queue of queues) {
    const jobs = await queue.getJobs(['failed'], 0, 5_000, false);
    total += jobs.filter((job) => {
      if (!allowedJobNames.has(job.name)) {
        return false;
      }
      if (getEventIdFromJob(job) !== eventId) {
        return false;
      }
      return (job.finishedOn ?? job.timestamp) >= stageStartedAtMs;
    }).length;
  }
  return total;
}

async function waitForStageCompletion(params: {
  stageLabel: string;
  eventId: number;
  queues: readonly Queue<unknown>[];
  allowedJobNames: ReadonlySet<string>;
  stageStartedAtMs: number;
  pollIntervalMs: number;
  timeoutMs: number;
}) {
  const {
    stageLabel,
    eventId,
    queues,
    allowedJobNames,
    stageStartedAtMs,
    pollIntervalMs,
    timeoutMs,
  } = params;
  const deadline = stageStartedAtMs + timeoutMs;

  while (Date.now() <= deadline) {
    const pending = await countMatchingJobs(
      queues,
      eventId,
      allowedJobNames,
      ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'],
    );
    const recentFailures = await countRecentFailures(
      queues,
      eventId,
      allowedJobNames,
      stageStartedAtMs,
    );

    if (recentFailures > 0) {
      throw new Error(
        `[${stageLabel}] Event ${eventId} has ${recentFailures} failed jobs after retries`,
      );
    }

    if (pending === 0) {
      return;
    }

    console.log(
      `[${stageLabel}] event=${eventId} pending=${pending}; waiting ${pollIntervalMs}ms...`,
    );
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`[${stageLabel}] timed out for event ${eventId} after ${timeoutMs}ms`);
}

async function runStage(params: {
  stageLabel: string;
  eventId: number;
  enqueue: () => Promise<{ id?: string | number | undefined }>;
  queues: readonly Queue<unknown>[];
  allowedJobNames: ReadonlySet<string>;
  pollIntervalMs: number;
  timeoutMs: number;
}) {
  const { stageLabel, eventId, enqueue, queues, allowedJobNames, pollIntervalMs, timeoutMs } = params;
  const stageStartedAtMs = Date.now();
  const job = await enqueue();
  console.log(`[${stageLabel}] enqueued event=${eventId} jobId=${String(job.id ?? 'unknown')}`);

  await waitForStageCompletion({
    stageLabel,
    eventId,
    queues,
    allowedJobNames,
    stageStartedAtMs,
    pollIntervalMs,
    timeoutMs,
  });

  console.log(`[${stageLabel}] completed event=${eventId}`);
}

async function resolveEventRange(startEventArg?: number, endEventArg?: number): Promise<number[]> {
  const db = await getDb();
  const currentEventRows = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.isCurrent, true))
    .limit(1);
  const currentEventId = currentEventRows[0]?.id;
  if (!currentEventId) {
    throw new Error('No current event found in database');
  }

  const startEventId = startEventArg ?? 1;
  const endEventId = endEventArg ?? currentEventId;
  if (startEventId > endEventId) {
    throw new Error(`Invalid range: startEventId(${startEventId}) > endEventId(${endEventId})`);
  }

  const eventRows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(gte(events.id, startEventId), lte(events.id, endEventId)))
    .orderBy(asc(events.id));

  const eventIds = eventRows.map((row: { id: number }) => row.id);
  if (eventIds.length === 0) {
    throw new Error(`No events found between ${startEventId} and ${endEventId}`);
  }

  return eventIds;
}

async function main() {
  const startEventId = parseIntArg('start-event');
  const endEventId = parseIntArg('end-event');
  const pollIntervalMs = parseDurationArg('poll-ms', DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = parseDurationArg('timeout-ms', DEFAULT_STAGE_TIMEOUT_MS);

  const entryQueues = collectUniqueQueues(
    entrySyncQueuesByTier as Record<'p0' | 'p1' | 'p2' | 'p3', Queue<unknown>>,
  );
  const leagueQueues = collectUniqueQueues(
    leagueSyncQueuesByTier as Record<'p0' | 'p1' | 'p2' | 'p3', Queue<unknown>>,
  );
  const tournamentQueues = collectUniqueQueues(
    tournamentSyncQueuesByTier as Record<'p0' | 'p1' | 'p2' | 'p3', Queue<unknown>>,
  );

  try {
    const eventIds = await resolveEventRange(startEventId, endEventId);
    console.log(
      `Starting auto-sub backfill for events: ${eventIds[0]}..${eventIds[eventIds.length - 1]} (${eventIds.length} events)`,
    );

    for (const eventId of eventIds) {
      console.log(`\n=== Event ${eventId} ===`);

      await runStage({
        stageLabel: 'entry-results',
        eventId,
        enqueue: () => enqueueEntryResultsSyncJob('manual', { eventId }),
        queues: entryQueues,
        allowedJobNames: new Set(['entry-results']),
        pollIntervalMs,
        timeoutMs,
      });

      await runStage({
        stageLabel: 'league-event-results',
        eventId,
        enqueue: () => enqueueLeagueEventResults(eventId, 'manual'),
        queues: leagueQueues,
        allowedJobNames: new Set(['league-event-results']),
        pollIntervalMs,
        timeoutMs,
      });

      await runStage({
        stageLabel: 'tournament-sync',
        eventId,
        enqueue: () => enqueueTournamentEventResults(eventId, 'manual'),
        queues: tournamentQueues,
        allowedJobNames: TOURNAMENT_BACKFILL_JOB_NAMES,
        pollIntervalMs,
        timeoutMs,
      });
    }

    console.log('\nAuto-sub backfill completed successfully.');
  } finally {
    await Promise.all([
      closeEntrySyncQueue(),
      closeLeagueSyncQueue(),
      closeTournamentSyncQueue(),
    ]);
  }
}

main().catch((error) => {
  console.error('Auto-sub backfill failed:', error);
  process.exit(1);
});
