import type { FplSeasonRef } from '../domain/fpl-season';
import { formatCronDateKey } from '../utils/timezone';
import {
  enqueueCoreSnapshotJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
} from '../jobs/data-sync-enqueue';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync-enqueue';
import { enqueueLeagueEventPicks, enqueueLeagueEventResults } from '../jobs/league-sync.jobs';
import {
  enqueueTournamentEventPicks,
  enqueueTournamentEventResults,
  enqueueTournamentInfo,
  enqueueTournamentRosterSync,
  enqueueTournamentTransfersPre,
} from '../jobs/tournament-sync.jobs';
import { enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import {
  enqueueBugReportCleanup,
  enqueueBugReportScreenshotRetention,
  enqueueLaunchMonitor,
  enqueuePlayerMarketFreshness,
  enqueuePlayerSeasonSummaryRepair,
  enqueuePostMatchConsolidation,
  enqueueTournamentTrendsRepair,
} from '../jobs/maintenance.jobs';
import { MAINTENANCE_JOBS } from '../queues/maintenance.queue';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import { coreSnapshotRefreshReason } from '../domain/core-snapshot-refresh';
import { getPostMatchResultsSlot } from '../domain/post-match-results';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { isMatchDayTime } from '../utils/conditions';
import { decideLiveLifecycle } from '../services/live-lifecycle-orchestrator';

export type SchedulerSource = 'schedule' | 'catchup' | 'reconcile' | 'manual';
export type CatchUpPolicy =
  | 'current-day-only'
  | 'latest-authoritative'
  | 'checkpoint'
  | 'event-checkpoint'
  | 'none';

export type SchedulerObligationPlan = Readonly<{
  scopeKey: string;
  periodKey: string;
  dueAt: Date;
  source: SchedulerSource;
  /** Event checkpoint carried through the durable obligation evidence. */
  eventId?: number;
  terminalStatus?: 'skipped' | 'irrecoverable';
  evidence?: Record<string, unknown>;
}>;

export type SchedulerContext = Readonly<{
  now: Date;
  season: FplSeasonRef;
  currentEventId?: number;
  currentEventDeadline?: Date;
  events: readonly {
    id: number;
    deadlineTime: Date | null;
  }[];
}>;

export type ScheduledJobDefinition = Readonly<{
  name: string;
  cadence: string;
  timezone: string;
  catchUpPolicy: CatchUpPolicy;
  criticality: 'critical' | 'normal' | 'maintenance';
  queueName: string;
  successPredicate: string;
  manualTrigger?: boolean;
  resolve: (context: SchedulerContext) => Promise<readonly SchedulerObligationPlan[]>;
  enqueue: (input: {
    context: SchedulerContext;
    plan: SchedulerObligationPlan;
    obligationId: string;
    generation: number;
  }) => Promise<{ bullJobId?: string | number; runId?: string } | void>;
}>;

function utc8DueAt(date: Date, hour: number, minute: number): Date {
  const key = formatCronDateKey(date);
  return new Date(
    `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`,
  );
}

function dailyDefinition(input: {
  name: string;
  hour: number;
  minute: number;
  cadence: string;
  catchUpPolicy: CatchUpPolicy;
  criticality: ScheduledJobDefinition['criticality'];
  queueName: string;
  successPredicate: string;
  enqueue: ScheduledJobDefinition['enqueue'];
}): ScheduledJobDefinition {
  return {
    ...input,
    timezone: 'Asia/Shanghai',
    resolve: async (context) => {
      const dueAt = utc8DueAt(context.now, input.hour, input.minute);
      const current: SchedulerObligationPlan = {
        scopeKey: context.season.seasonCode,
        periodKey: formatCronDateKey(context.now),
        dueAt,
        source: 'catchup',
      };
      if (input.catchUpPolicy !== 'current-day-only') {
        if (context.now < dueAt) return [];
        return [current];
      }

      // A daily market window is intentionally not replayed for old UTC+8
      // dates. Keep a bounded terminal history so every outage date is
      // explicit (including a date that is more than one day behind a
      // restart), while never replaying a mutable historical market source.
      const terminalPlans: SchedulerObligationPlan[] = [];
      for (let daysAgo = 1; daysAgo <= 31; daysAgo += 1) {
        const previousDueAt = new Date(dueAt.getTime() - daysAgo * 24 * 60 * 60_000);
        terminalPlans.push({
          scopeKey: context.season.seasonCode,
          periodKey: formatCronDateKey(previousDueAt),
          dueAt: previousDueAt,
          source: 'reconcile',
          terminalStatus: 'irrecoverable',
          evidence: { reason: 'market-window-expired', policy: input.catchUpPolicy },
        });
      }
      return [...terminalPlans, ...(context.now >= dueAt ? [current] : [])];
    },
  };
}

function contentDefinition(): ScheduledJobDefinition {
  return {
    name: 'content-acquisition',
    cadence: 'existing source_schedules checkpoint loop',
    timezone: 'UTC',
    catchUpPolicy: 'checkpoint',
    criticality: 'normal',
    queueName: 'content-*',
    successPredicate: 'existing content source_schedules/job_outbox checkpoints advance',
    manualTrigger: false,
    // Content already has durable source_schedules and job_outbox authorities.
    // The standalone content-worker owns their lease/reconciliation loop; the
    // FPL scheduler catalog exposes the contract without creating a second
    // obligation table or duplicate enqueue path.
    resolve: async () => [],
    enqueue: async () => undefined,
  };
}

function eventDefinition(input: {
  name: string;
  cadence: string;
  catchUpPolicy: CatchUpPolicy;
  criticality: ScheduledJobDefinition['criticality'];
  queueName: string;
  successPredicate: string;
  /** Checkpoint jobs must reconcile every due event, not just the current one. */
  allDueEvents?: boolean;
  enqueue: ScheduledJobDefinition['enqueue'];
}): ScheduledJobDefinition {
  return {
    ...input,
    timezone: 'UTC',
    resolve: async (context) => {
      const candidates = input.allDueEvents
        ? context.events
        : context.currentEventId && context.currentEventDeadline
          ? [{ id: context.currentEventId, deadlineTime: context.currentEventDeadline }]
          : [];
      return candidates.flatMap((event) => {
        if (!event.deadlineTime) return [];
        const dueAt = new Date(event.deadlineTime.getTime() + 30 * 60_000);
        if (context.now < dueAt) return [];
        return [
          {
            scopeKey: `${context.season.seasonCode}:event:${event.id}`,
            periodKey: `event-${event.id}`,
            dueAt,
            eventId: event.id,
            source: 'catchup' as const,
          },
        ];
      });
    },
  };
}

function periodicMaintenanceDefinition(input: {
  name: string;
  cadence: string;
  periodMs: number;
  minuteOfHour?: number;
  criticality: ScheduledJobDefinition['criticality'];
  successPredicate: string;
  enqueue: ScheduledJobDefinition['enqueue'];
}): ScheduledJobDefinition {
  return {
    name: input.name,
    cadence: input.cadence,
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: input.criticality,
    queueName: 'maintenance',
    successPredicate: input.successPredicate,
    resolve: async (context) => {
      // Compute the period relative to the scheduled minute instead of
      // requiring the scheduler to be alive during one exact wall-clock
      // minute. This makes an hourly-at-:17 job catch up after a restart at
      // 10:18 while the durable (job, scope, period) key still prevents a
      // duplicate within that hour.
      const offsetMs = (input.minuteOfHour ?? 0) * 60_000;
      const bucket = Math.floor((context.now.getTime() - offsetMs) / input.periodMs);
      const dueAt = new Date(bucket * input.periodMs + offsetMs);
      if (context.now < dueAt) return [];
      return [
        {
          scopeKey: context.season.seasonCode,
          periodKey: `maintenance-${bucket}`,
          dueAt,
          source: 'catchup' as const,
        },
      ];
    },
    enqueue: input.enqueue,
  };
}

function postMatchMaintenanceDefinition(): ScheduledJobDefinition {
  return {
    name: MAINTENANCE_JOBS.POST_MATCH_CONSOLIDATION,
    cadence: '06:00, 08:00 and 10:00 UTC+8 in the post-match window',
    timezone: 'Asia/Shanghai',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'maintenance',
    // This coordinator only fans out the final live/player-stat work.  The
    // durable live-finalization and player-stats obligations carry the actual
    // checkpoint success evidence; do not mark this enqueue obligation as if
    // those downstream writes had already completed.
    successPredicate: 'post-match finalization coordinator enqueues downstream checkpoint jobs',
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const event = await eventRepository.findById(context.season, context.currentEventId);
      if (!event) return [];
      const fixtures = await fixtureRepository.findByEvent(context.season, event.id);
      const resultSlot = getPostMatchResultsSlot(event, fixtures, context.now);
      if (!resultSlot) return [];
      const dateKey = formatCronDateKey(context.now);
      const hours = [6, 8, 10];
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Shanghai',
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(context.now),
      );
      if (!hours.includes(hour)) return [];
      const dueAt = utc8DueAt(context.now, hour, 0);
      if (context.now < dueAt) return [];
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `post-match-${dateKey}-${hour}-${resultSlot}`,
          dueAt,
          eventId: event.id,
          source: 'catchup' as const,
          evidence: { resultSlot },
        },
      ];
    },
    enqueue: async ({ context, obligationId, generation }) => {
      const job = await enqueuePostMatchConsolidation(context.season, 'catchup', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  };
}

function liveSnapshotDefinition(): ScheduledJobDefinition {
  return {
    name: 'live-snapshot',
    cadence: '30-second lifecycle poll while match windows are open',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'live-data',
    successPredicate: 'live snapshot checked and publication/durable rows advanced',
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const currentEvent = context.events.find((event) => event.id === context.currentEventId);
      if (!currentEvent?.deadlineTime) return [];
      const event = await eventRepository.findById(context.season, context.currentEventId);
      if (!event) return [];
      const fixtures = await fixtureRepository.findByEvent(context.season, event.id);
      if (!isMatchDayTime(event, fixtures, context.now)) return [];
      const bucket = Math.floor(context.now.getTime() / 30_000);
      const persistBucket = Math.floor(context.now.getTime() / (10 * 60_000));
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `live-${event.id}-${bucket}`,
          dueAt: context.now,
          eventId: event.id,
          source: 'reconcile',
          evidence: {
            persistEventLives: context.now.getTime() % (10 * 60_000) < 30_000,
            persistBucket,
          },
        },
      ];
    },
    enqueue: async ({ context, plan, obligationId, generation }) => {
      const eventId = plan.eventId ?? context.currentEventId;
      if (!eventId) throw new Error('Live snapshot obligation has no event checkpoint');
      const job = await enqueueLiveSnapshot(context.season, eventId, 'reconcile', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        persistEventLives: plan.evidence?.persistEventLives === true,
        reuseExisting: true,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job?.id, runId: job?.data?.runId };
    },
  };
}

function coreLifecycleReconcileDefinition(): ScheduledJobDefinition {
  return {
    name: 'core-current-reconcile',
    cadence: '30-second lifecycle reconciliation',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'data-sync',
    successPredicate: 'core publication lifecycle matches canonical event and fixtures',
    resolve: async (context) => {
      const current = context.currentEventId
        ? await eventRepository.findById(context.season, context.currentEventId)
        : null;
      if (!current) return [];
      const fixtures = await fixtureRepository.findByEvent(context.season, current.id);
      const publication = await readCoreSnapshotCache(context.season.seasonCode);
      const reason = coreSnapshotRefreshReason(current, fixtures, publication, context.now);
      if (!reason) return [];
      return [
        {
          scopeKey: `${context.season.seasonCode}:core-lifecycle`,
          // Keep one durable reconciliation obligation for the current event
          // until its publication catches up.  A 30-second resolver tick must
          // not manufacture a parallel full core rebuild every time it sees
          // the same mismatch.
          periodKey: `core-lifecycle-${current.id}`,
          dueAt: context.now,
          eventId: current.id,
          source: 'reconcile' as const,
          evidence: { reason, targetEventId: current.id },
        },
      ];
    },
    enqueue: async ({ context, obligationId, generation }) => {
      const job = await enqueueCoreSnapshotJob(context.season, 'reconcile', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        removeOnSettle: false,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  };
}

function liveFinalizationDefinition(): ScheduledJobDefinition {
  return {
    name: 'live-finalization',
    cadence: '30-second post-match finalization reconciliation',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'live-data',
    successPredicate: 'final live snapshot and event checkpoint persisted',
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const event = await eventRepository.findById(context.season, context.currentEventId);
      if (!event) return [];
      const fixtures = await fixtureRepository.findByEvent(context.season, event.id);
      const resultSlot = getPostMatchResultsSlot(event, fixtures, context.now);
      if (!resultSlot?.startsWith('final-')) return [];
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `live-final-${event.id}-${resultSlot}`,
          dueAt: context.now,
          eventId: event.id,
          source: 'reconcile' as const,
          evidence: { resultSlot, finalizeEvent: true, persistEventLives: true },
        },
      ];
    },
    enqueue: async ({ context, plan, obligationId, generation }) => {
      const eventId = plan.eventId ?? context.currentEventId;
      if (!eventId) throw new Error('Live finalization obligation has no event checkpoint');
      const job = await enqueueLiveSnapshot(context.season, eventId, 'reconcile', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        persistEventLives: true,
        finalizeEvent: true,
        reuseExisting: true,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job?.id, runId: job?.data?.runId };
    },
  };
}

function activePlayerStatsDefinition(): ScheduledJobDefinition {
  return {
    name: 'player-stats-active',
    cadence: 'one-minute live window / five-minute settling repair',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'normal',
    queueName: 'data-sync',
    successPredicate: 'player stats for the active event persist for the current bucket',
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const event = await eventRepository.findById(context.season, context.currentEventId);
      if (!event) return [];
      const fixtures = await fixtureRepository.findByEvent(context.season, event.id);
      const decision = decideLiveLifecycle(event, fixtures, context.now);
      const liveWindow = decision.state === 'LIVE_ACTIVE' || decision.state === 'DAY_SETTLING';
      if (!liveWindow && context.now.getUTCMinutes() % 5 !== 0) return [];
      const bucket = Math.floor(context.now.getTime() / 60_000);
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `player-stats-${event.id}-${bucket}`,
          dueAt: context.now,
          eventId: event.id,
          source: 'reconcile' as const,
          evidence: { lifecycleState: decision.state, liveWindow },
        },
      ];
    },
    enqueue: async ({ context, plan, obligationId, generation }) => {
      const eventId = plan.eventId ?? context.currentEventId;
      if (!eventId) throw new Error('Active player stats obligation has no event checkpoint');
      const job = await enqueuePlayerStatsSyncJob(context.season, 'reconcile', {
        eventId,
        jobId: `scheduler-${obligationId}-g${generation}`,
        removeOnSettle: false,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  };
}

export function createSchedulerRegistry(): readonly ScheduledJobDefinition[] {
  return [
    coreLifecycleReconcileDefinition(),
    dailyDefinition({
      name: 'core-snapshot',
      hour: 6,
      minute: 35,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'critical',
      queueName: 'data-sync',
      successPredicate: 'core publication active for current authoritative event',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueCoreSnapshotJob(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    dailyDefinition({
      name: 'market-daily',
      hour: 9,
      minute: 25,
      cadence: 'daily',
      catchUpPolicy: 'current-day-only',
      criticality: 'critical',
      queueName: 'data-sync',
      successPredicate: 'complete market snapshot and delivered publication',
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const job = await enqueuePlayerValuesSyncJob(context.season, 'catchup', {
          changeDate: plan.periodKey,
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    dailyDefinition({
      name: 'player-stats',
      hour: 9,
      minute: 40,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'normal',
      queueName: 'data-sync',
      successPredicate: 'current or latest event player stats persisted',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueuePlayerStatsSyncJob(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    dailyDefinition({
      name: MAINTENANCE_JOBS.PLAYER_MARKET_FRESHNESS,
      hour: 9,
      minute: 36,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'normal',
      queueName: 'maintenance',
      successPredicate: 'market freshness watchdog verifies a complete current snapshot',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueuePlayerMarketFreshness(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    dailyDefinition({
      name: MAINTENANCE_JOBS.BUG_REPORT_CLEANUP,
      hour: 3,
      minute: 15,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'maintenance',
      queueName: 'maintenance',
      successPredicate: 'expired bug-report rows are deleted or retained for retry',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueBugReportCleanup(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    dailyDefinition({
      name: MAINTENANCE_JOBS.BUG_REPORT_SCREENSHOT_RETENTION,
      hour: 3,
      minute: 20,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'maintenance',
      queueName: 'maintenance',
      successPredicate: 'expired and orphaned private screenshot objects are reconciled',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueBugReportScreenshotRetention(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    periodicMaintenanceDefinition({
      name: MAINTENANCE_JOBS.PLAYER_SEASON_SUMMARY,
      cadence: 'hourly at minute 17',
      periodMs: 60 * 60_000,
      minuteOfHour: 17,
      criticality: 'normal',
      successPredicate: 'player season summary and state projections are refreshed',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueuePlayerSeasonSummaryRepair(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    periodicMaintenanceDefinition({
      name: MAINTENANCE_JOBS.TOURNAMENT_TRENDS,
      cadence: 'every five minutes',
      periodMs: 5 * 60_000,
      criticality: 'normal',
      successPredicate: 'active tournament public trend scopes are published',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueTournamentTrendsRepair(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    periodicMaintenanceDefinition({
      name: MAINTENANCE_JOBS.LAUNCH_MONITOR,
      cadence: 'every five minutes',
      periodMs: 5 * 60_000,
      criticality: 'maintenance',
      successPredicate: 'launch state and notification transitions are evaluated idempotently',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueLaunchMonitor(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    postMatchMaintenanceDefinition(),
    dailyDefinition({
      name: 'entry-info',
      hour: 10,
      minute: 30,
      cadence: 'daily',
      catchUpPolicy: 'checkpoint',
      criticality: 'normal',
      queueName: 'entry-sync',
      successPredicate: 'entry info daily checkpoint advances',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueEntryInfoSyncJob(context.season, 'catchup', {
          eventId: context.currentEventId ?? 0,
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    dailyDefinition({
      name: 'tournament-roster',
      hour: 10,
      minute: 45,
      cadence: 'daily',
      catchUpPolicy: 'checkpoint',
      criticality: 'normal',
      queueName: 'tournament-sync',
      successPredicate: 'tournament roster checkpoint advances',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueTournamentRosterSync(context.season, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return {
          bullJobId: job.id ?? `scheduler-${obligationId}-g${generation}`,
          runId: job.data.runId,
        };
      },
    }),
    dailyDefinition({
      name: 'tournament-info',
      hour: 10,
      minute: 45,
      cadence: 'daily',
      catchUpPolicy: 'checkpoint',
      criticality: 'normal',
      queueName: 'tournament-sync',
      successPredicate: 'tournament metadata checkpoint advances',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueTournamentInfo(context.season, 0, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return {
          bullJobId: job.id ?? `scheduler-${obligationId}-g${generation}`,
          runId: job.data.runId,
        };
      },
    }),
    eventDefinition({
      name: 'entry-picks',
      cadence: 'post-deadline window',
      catchUpPolicy: 'checkpoint',
      criticality: 'critical',
      queueName: 'entry-sync',
      successPredicate: 'entry picks checkpoint covers known entries for event',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Entry picks obligation has no event checkpoint');
        const job = await enqueueEntryPicksSyncJob(context.season, 'catchup', {
          eventId,
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    eventDefinition({
      name: 'entry-transfers',
      cadence: 'post-deadline window',
      catchUpPolicy: 'checkpoint',
      criticality: 'critical',
      queueName: 'entry-sync',
      successPredicate: 'entry transfers checkpoint covers known entries for event',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Entry transfers obligation has no event checkpoint');
        const job = await enqueueEntryTransfersSyncJob(context.season, 'catchup', {
          eventId,
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    eventDefinition({
      name: 'entry-results',
      cadence: 'post-deadline event checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'normal',
      queueName: 'entry-sync',
      successPredicate: 'entry results checkpoint covers known entries for event',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Entry results obligation has no event checkpoint');
        const job = await enqueueEntryResultsSyncJob(context.season, 'catchup', {
          eventId,
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    eventDefinition({
      name: 'league-event-picks',
      cadence: 'post-deadline event checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'normal',
      queueName: 'league-sync',
      successPredicate: 'league picks coordinator enqueues every active-league checkpoint',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('League picks obligation has no event checkpoint');
        const job = await enqueueLeagueEventPicks(context.season, eventId, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    eventDefinition({
      name: 'league-event-results',
      cadence: 'post-deadline event checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'critical',
      queueName: 'league-sync',
      successPredicate: 'league results coordinator enqueues every active-league checkpoint',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('League results obligation has no event checkpoint');
        const job = await enqueueLeagueEventResults(context.season, eventId, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    eventDefinition({
      name: 'tournament-event-results',
      cadence: 'post-deadline event checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'critical',
      queueName: 'tournament-sync',
      successPredicate:
        'tournament result and cascade jobs enqueue; persistent barrier owns downstream completion',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Tournament results obligation has no event checkpoint');
        const job = await enqueueTournamentEventResults(context.season, eventId, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    eventDefinition({
      name: 'tournament-event-picks',
      cadence: 'post-deadline event checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'normal',
      queueName: 'tournament-sync',
      successPredicate: 'tournament picks checkpoint advances',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Tournament picks obligation has no event checkpoint');
        const job = await enqueueTournamentEventPicks(context.season, eventId, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return {
          bullJobId: job.id ?? `scheduler-${obligationId}-g${generation}`,
          runId: job.data.runId,
        };
      },
    }),
    eventDefinition({
      name: 'tournament-transfers-pre',
      cadence: 'post-deadline event checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'normal',
      queueName: 'tournament-sync',
      successPredicate: 'tournament transfer checkpoint advances',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Tournament transfers obligation has no event checkpoint');
        const job = await enqueueTournamentTransfersPre(context.season, eventId, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return {
          bullJobId: job.id ?? `scheduler-${obligationId}-g${generation}`,
          runId: job.data.runId,
        };
      },
    }),
    liveSnapshotDefinition(),
    liveFinalizationDefinition(),
    activePlayerStatsDefinition(),
    contentDefinition(),
  ];
}

export async function resolveSchedulerContext(
  season: FplSeasonRef,
  now = new Date(),
): Promise<SchedulerContext> {
  // Use the canonical event ledger for reconciliation.  A Redis core pointer
  // may be stale/ghost during recovery and must not decide which checkpoint is
  // eligible for catch-up.
  const events = (await eventRepository.findAll(season))
    .filter((event) => Number.isInteger(event.id) && event.id > 0)
    .map((event) => ({
      id: event.id,
      deadlineTime: event.deadlineTime ? new Date(event.deadlineTime) : null,
    }));
  const currentEvent = events
    .filter((event) => event.deadlineTime && event.deadlineTime.getTime() <= now.getTime())
    .sort(
      (left, right) => (right.deadlineTime?.getTime() ?? 0) - (left.deadlineTime?.getTime() ?? 0),
    )[0];
  return {
    now,
    season,
    events,
    ...(currentEvent?.id ? { currentEventId: currentEvent.id } : {}),
    ...(currentEvent?.deadlineTime ? { currentEventDeadline: currentEvent.deadlineTime } : {}),
  };
}

export const schedulerRegistry = createSchedulerRegistry();
