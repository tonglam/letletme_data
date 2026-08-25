import type { FplSeasonRef } from '../domain/fpl-season';
import type { Fixture } from '../types';
import { formatCronDateKey } from '../utils/timezone';
import {
  enqueueCoreSnapshotJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
  enqueuePriceChangePredictionsJob,
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
  enqueueTournamentOfficialH2H,
  enqueueTournamentRosterSync,
  enqueueTournamentTransfersPre,
  hasPendingOfficialH2HJob,
} from '../jobs/tournament-sync.jobs';
import { enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import {
  enqueueBugReportCleanup,
  enqueueBugReportScreenshotRetention,
  enqueueLaunchMonitor,
  enqueuePlayerMarketFreshness,
  enqueuePlayerSeasonSummaryRepair,
  enqueuePostMatchConsolidation,
  enqueueMyFplSnapshot,
  enqueueMyFplSnapshotOutbox,
  enqueueTournamentTrendsRepair,
} from '../jobs/maintenance.jobs';
import { enqueueUnderstatPlayerSync, enqueueUnderstatTeamSync } from '../jobs/understat-enqueue';
import { enqueueUnderstatOrphanReconciler } from '../jobs/understat-recovery.jobs';
import { MAINTENANCE_JOBS } from '../queues/maintenance.queue';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import {
  coreLifecycleReconcilePeriodKey,
  coreSnapshotRefreshReason,
} from '../domain/core-snapshot-refresh';
import { resolvePlayerStatsActiveCadence } from '../domain/job-schedules';
import {
  getPostMatchResultsCheckpoint,
  getPostMatchResultsSlot,
} from '../domain/post-match-results';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { loadDataPublicationDelivery } from '../repositories/data-publication-outbox';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { isMatchDayTime } from '../utils/conditions';
import {
  decideLiveLifecycle,
  resolveLiveLifecycleDelay,
  shouldRefreshOfficialH2H,
} from '../services/live-lifecycle-orchestrator';
import { hasFinalMyFplPublication } from '../services/my-fpl-snapshot-publication.service';
import { getConfig } from '../utils/config';

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
  latestFinalizedEventId?: number;
  events: readonly {
    id: number;
    deadlineTime: Date | null;
    finished?: boolean;
    dataChecked?: boolean;
    dataCheckedAt?: Date | null;
    updatedAt?: Date | null;
  }[];
}>;

export function resolveEntryInfoSnapshotTargetEventId(
  context: Pick<SchedulerContext, 'latestFinalizedEventId'>,
): number {
  return context.latestFinalizedEventId ?? 0;
}

export type ScheduledJobDefinition = Readonly<{
  name: string;
  cadence: string;
  timezone: string;
  catchUpPolicy: CatchUpPolicy;
  criticality: 'critical' | 'normal' | 'maintenance';
  queueName: string;
  successPredicate: string;
  /**
   * Bull completion evidence used only when recovering an expired scheduler
   * lease. Most workers settle the obligation from their root job, but
   * durable chains must reach their semantic finalizer first.
   */
  recoveryCompletionMode?:
    | 'root-job'
    | 'entry-scan-finalizer'
    | 'tournament-cascade-finalizer'
    | 'understat-finalizer';
  manualTrigger?: boolean;
  /** Scheduler-only definitions can be excluded from claims while disabled. */
  isEnabled?: () => boolean;
  /**
   * Capacity lanes acquired atomically before a scheduler obligation is
   * claimed. Definitions that share any lane cannot be in flight together.
   * The default lane is the Bull queue name.
   */
  executionLanes?: readonly string[];
  /** Lower values claim first when several definitions share a lane. */
  claimPriority?: number;
  resolve: (context: SchedulerContext) => Promise<readonly SchedulerObligationPlan[]>;
  enqueue: (input: {
    context: SchedulerContext;
    plan: SchedulerObligationPlan;
    obligationId: string;
    generation: number;
    /** Provider-specific season selected by a scheduler definition. */
    seasonCode?: string;
  }) => Promise<{ bullJobId?: string | number; runId?: string } | void>;
}>;

// A scheduler pass creates one context. Definitions share the same current
// event row and one all-fixtures read through these context-scoped promises,
// avoiding repeated PostgreSQL reads every 30 seconds without retaining stale
// data across passes.
const schedulerEventReads = new WeakMap<
  SchedulerContext,
  Map<number, ReturnType<typeof eventRepository.findById>>
>();
const schedulerAllFixtureReads = new WeakMap<
  SchedulerContext,
  ReturnType<typeof fixtureRepository.findAll>
>();

function loadSchedulerEvent(context: SchedulerContext, eventId: number) {
  let reads = schedulerEventReads.get(context);
  if (!reads) {
    reads = new Map();
    schedulerEventReads.set(context, reads);
  }
  let value = reads.get(eventId);
  if (!value) {
    value = eventRepository.findById(context.season, eventId);
    reads.set(eventId, value);
  }
  return value;
}

async function loadSchedulerFixtures(context: SchedulerContext, eventId: number) {
  let allFixtures = schedulerAllFixtureReads.get(context);
  if (!allFixtures) {
    allFixtures = fixtureRepository.findAll(context.season);
    schedulerAllFixtureReads.set(context, allFixtures);
  }
  return (await allFixtures).filter((fixture) => fixture.event === eventId);
}

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
  recoveryCompletionMode?: ScheduledJobDefinition['recoveryCompletionMode'];
  enqueue: ScheduledJobDefinition['enqueue'];
}): ScheduledJobDefinition {
  return {
    ...input,
    timezone: 'Asia/Shanghai',
    resolve: async (context) => {
      const todayDueAt = utc8DueAt(context.now, input.hour, input.minute);
      const latestAuthoritativeDueAt =
        context.now >= todayDueAt ? todayDueAt : new Date(todayDueAt.getTime() - 24 * 60 * 60_000);
      const current: SchedulerObligationPlan = {
        scopeKey: context.season.seasonCode,
        periodKey: formatCronDateKey(latestAuthoritativeDueAt),
        dueAt: latestAuthoritativeDueAt,
        source: 'catchup',
      };
      if (input.catchUpPolicy !== 'current-day-only') {
        // Only latest-authoritative daily work replays yesterday's final
        // checkpoint before today's due time. Checkpoint jobs retain their
        // explicit daily boundary.
        if (context.now < todayDueAt && input.catchUpPolicy !== 'latest-authoritative') {
          return [];
        }
        return [current];
      }

      // A daily market window is intentionally not replayed for old UTC+8
      // dates. Keep a bounded terminal history so every outage date is
      // explicit (including a date that is more than one day behind a
      // restart), while never replaying a mutable historical market source.
      const terminalPlans: SchedulerObligationPlan[] = [];
      for (let daysAgo = 1; daysAgo <= 31; daysAgo += 1) {
        const previousDueAt = new Date(todayDueAt.getTime() - daysAgo * 24 * 60 * 60_000);
        terminalPlans.push({
          scopeKey: context.season.seasonCode,
          periodKey: formatCronDateKey(previousDueAt),
          dueAt: previousDueAt,
          source: 'reconcile',
          terminalStatus: 'irrecoverable',
          evidence: { reason: 'market-window-expired', policy: input.catchUpPolicy },
        });
      }
      const currentDayPlan: SchedulerObligationPlan = {
        ...current,
        periodKey: formatCronDateKey(todayDueAt),
        dueAt: todayDueAt,
      };
      return [...terminalPlans, ...(context.now >= todayDueAt ? [currentDayPlan] : [])];
    },
  };
}

export function understatDailyDefinition(
  input: {
    name: string;
    hour: number;
    minute: number;
    queueName: string;
    successPredicate: string;
    recoveryCompletionMode?: ScheduledJobDefinition['recoveryCompletionMode'];
    enqueue: ScheduledJobDefinition['enqueue'];
  },
  isEnabled: () => boolean = () => getConfig().UNDERSTAT_ENABLED,
  resolveSeasonCode: () => string = () => getConfig().UNDERSTAT_SEASON,
): ScheduledJobDefinition {
  const definition = dailyDefinition({
    ...input,
    cadence: 'daily UTC+8 incremental',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'normal',
  });
  return {
    ...definition,
    manualTrigger: false,
    isEnabled,
    resolve: async (context) => {
      if (!isEnabled()) return [];
      const seasonCode = resolveSeasonCode();
      return (await definition.resolve(context)).map((plan) => ({
        ...plan,
        scopeKey: seasonCode,
      }));
    },
    enqueue: async (enqueueInput) =>
      definition.enqueue({
        ...enqueueInput,
        // Carry the exact season selected when this obligation was reserved.
        // This prevents a process-level config change/restart from enqueueing
        // an older obligation into a different Understat season.
        seasonCode: enqueueInput.plan.scopeKey,
      }),
  };
}

function understatOrphanReconcilerDefinition(): ScheduledJobDefinition {
  const isEnabled = () => getConfig().UNDERSTAT_ENABLED;
  const definition = periodicMaintenanceDefinition({
    name: MAINTENANCE_JOBS.UNDERSTAT_ORPHAN_RECONCILER,
    cadence: 'every 30 minutes',
    periodMs: 30 * 60_000,
    criticality: 'maintenance',
    successPredicate: 'active Understat runs without progress are reconciled safely',
    enqueue: async ({ context, obligationId, generation }) => {
      const job = await enqueueUnderstatOrphanReconciler(context.season, 'catchup', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  });
  return {
    ...definition,
    manualTrigger: false,
    isEnabled,
    resolve: async (context) => (isEnabled() ? definition.resolve(context) : []),
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
  recoveryCompletionMode?: ScheduledJobDefinition['recoveryCompletionMode'];
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

type PostMatchFixturesLoader = (
  season: FplSeasonRef,
  eventId: number,
) => ReturnType<typeof fixtureRepository.findByEvent>;

function postMatchFixtureAuthority(fixtures: readonly Fixture[]): Readonly<{
  resultAuthorityAtMs: number;
  resultScheduleAnchorMs: number;
}> {
  const kickoffTimes = fixtures
    .map((fixture) => fixture.kickoffTime?.getTime())
    .filter(
      (kickoffTime): kickoffTime is number =>
        kickoffTime !== undefined && Number.isSafeInteger(kickoffTime) && kickoffTime > 0,
    );
  if (kickoffTimes.length === 0) {
    throw new Error('Post-match fixtures have no durable schedule anchor');
  }
  const resultScheduleAnchorMs = Math.max(...kickoffTimes);
  const persistedUpdates = fixtures
    .map((fixture) => fixture.updatedAt?.getTime())
    .filter(
      (updatedAt): updatedAt is number =>
        updatedAt !== undefined && Number.isSafeInteger(updatedAt) && updatedAt > 0,
    );
  if (persistedUpdates.length > 0) {
    return {
      resultAuthorityAtMs: Math.max(...persistedUpdates),
      resultScheduleAnchorMs,
    };
  }

  // Production fixture rows have a non-null updated_at. Keep a deterministic
  // compatibility value for injected/unit fixtures while never using wall time
  // as authority.
  return {
    resultAuthorityAtMs: resultScheduleAnchorMs,
    resultScheduleAnchorMs,
  };
}

/**
 * Results are meaningful only after the final fixture's expected end. During
 * the first 24 hours each event gets one idempotent hourly checkpoint. Once
 * FPL marks an event finished and data_checked, a stable final checkpoint
 * remains eligible forever so scheduler downtime cannot strand historical GWs.
 */
export async function resolvePostMatchResultPlans(
  context: SchedulerContext,
  loadFixtures: PostMatchFixturesLoader = (_season, eventId) =>
    loadSchedulerFixtures(context, eventId),
): Promise<readonly SchedulerObligationPlan[]> {
  const plans: SchedulerObligationPlan[] = [];
  const unsettledEvents: SchedulerContext['events'][number][] = [];

  for (const event of context.events) {
    if (event.finished && event.dataChecked) {
      const dueAt = event.dataCheckedAt ?? event.deadlineTime ?? context.now;
      if (context.now < dueAt) continue;
      plans.push({
        scopeKey: `${context.season.seasonCode}:event:${event.id}`,
        periodKey: `event-${event.id}-final`,
        dueAt,
        eventId: event.id,
        source: 'catchup',
        evidence: {
          resultSlot: 'final-checkpoint',
          resultAuthorityAtMs: (
            event.updatedAt ??
            event.dataCheckedAt ??
            event.deadlineTime ??
            dueAt
          ).getTime(),
          resultScheduleAnchorMs: dueAt.getTime(),
          dataCheckedAt: event.dataCheckedAt?.toISOString() ?? null,
        },
      });
      continue;
    }
    unsettledEvents.push(event);
  }

  const provisional = await Promise.all(
    unsettledEvents.map(async (event): Promise<SchedulerObligationPlan | null> => {
      const fixtures = await loadFixtures(context.season, event.id);
      const checkpoint = getPostMatchResultsCheckpoint(
        { dataChecked: event.dataChecked === true },
        fixtures,
        context.now,
      );
      if (!checkpoint) return null;
      return {
        scopeKey: `${context.season.seasonCode}:event:${event.id}`,
        periodKey: `event-${event.id}-${checkpoint.slot}`,
        dueAt: checkpoint.dueAt,
        eventId: event.id,
        source: 'reconcile',
        evidence: { resultSlot: checkpoint.slot, ...postMatchFixtureAuthority(fixtures) },
      };
    }),
  );
  return [
    ...plans,
    ...provisional.filter((plan): plan is SchedulerObligationPlan => plan !== null),
  ];
}

const postMatchPlanCache = new WeakMap<
  SchedulerContext,
  Promise<readonly SchedulerObligationPlan[]>
>();

function resultEventDefinition(
  input: Omit<ScheduledJobDefinition, 'timezone' | 'resolve'>,
): ScheduledJobDefinition {
  return {
    ...input,
    timezone: 'UTC',
    resolve: (context) => {
      const cached = postMatchPlanCache.get(context);
      if (cached) return cached;
      const plans = resolvePostMatchResultPlans(context);
      postMatchPlanCache.set(context, plans);
      return plans;
    },
  };
}

function myFplSnapshotDefinition(): ScheduledJobDefinition {
  return {
    name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT,
    cadence: 'daily at 10:45 UTC+8 and finalization reconciliation',
    timezone: 'Asia/Shanghai',
    catchUpPolicy: 'checkpoint',
    criticality: 'critical',
    queueName: 'maintenance',
    successPredicate: 'complete My FPL projection published as one active revision',
    executionLanes: [
      'queue:data-sync',
      'queue:entry-sync',
      'queue:tournament-sync',
      'queue:league-sync',
      'post-match-results',
    ],
    claimPriority: 50,
    resolve: async (context) => {
      const dueAt = utc8DueAt(context.now, 10, 45);
      if (context.now < dueAt) return [];
      const plans: SchedulerObligationPlan[] = [];
      const dateKey = formatCronDateKey(context.now);
      for (const event of context.events) {
        if (!event.deadlineTime || event.deadlineTime > context.now) continue;
        if (event.finished && event.dataChecked) continue;
        if (await hasFinalMyFplPublication(context.season, event.id)) continue;
        plans.push({
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `daily-${event.id}-${dateKey}`,
          dueAt,
          eventId: event.id,
          source: 'catchup',
          evidence: { snapshotKind: 'PROVISIONAL', snapshotDate: dateKey },
        });
      }
      return plans;
    },
    enqueue: async ({ context, plan, obligationId, generation }) => {
      const eventId = plan.eventId;
      if (!eventId) throw new Error('My FPL snapshot obligation has no event checkpoint');
      const job = await enqueueMyFplSnapshot(context.season, 'catchup', {
        eventId,
        snapshotKind: 'PROVISIONAL',
        freshAfter: plan.dueAt.toISOString(),
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  };
}

function myFplFinalizationDefinition(): ScheduledJobDefinition {
  return {
    name: 'my-fpl-finalization',
    cadence: '30-second finished + data_checked reconciliation',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'maintenance',
    successPredicate: 'final My FPL revision replaces the provisional revision',
    executionLanes: [
      'queue:data-sync',
      'queue:entry-sync',
      'queue:tournament-sync',
      'queue:league-sync',
      'post-match-results',
    ],
    // A final checkpoint supersedes an older pending provisional snapshot.
    // The eventual provisional worker then observes the active FINAL revision
    // and exits without publishing stale authority.
    claimPriority: 45,
    resolve: async (context) => {
      const plans: SchedulerObligationPlan[] = [];
      for (const event of context.events) {
        if (!event.finished || !event.dataChecked) continue;
        const checkedAt = event.dataCheckedAt?.toISOString() ?? 'unknown';
        plans.push({
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `final-${event.id}-${checkedAt}`,
          dueAt: context.now,
          eventId: event.id,
          source: 'reconcile',
          evidence: { snapshotKind: 'FINAL', dataCheckedAt: checkedAt },
        });
      }
      return plans;
    },
    enqueue: async ({ context, plan, obligationId, generation }) => {
      const eventId = plan.eventId;
      if (!eventId) throw new Error('My FPL finalization obligation has no event checkpoint');
      const job = await enqueueMyFplSnapshot(context.season, 'reconcile', {
        eventId,
        snapshotKind: 'FINAL',
        freshAfter: plan.dueAt.toISOString(),
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  };
}

function myFplSnapshotOutboxDefinition(): ScheduledJobDefinition {
  return periodicMaintenanceDefinition({
    name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX,
    cadence: 'every five minutes',
    periodMs: 5 * 60_000,
    criticality: 'critical',
    successPredicate: 'committed My FPL Redis manifests are delivered or retried',
    enqueue: async ({ context, obligationId, generation }) => {
      const job = await enqueueMyFplSnapshotOutbox(context.season, 'catchup', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  });
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

function priceChangePredictionsDefinition(): ScheduledJobDefinition {
  const periodMs = 5 * 60_000;
  const offsetMs = 60_000;
  return {
    name: 'price-change-predictions',
    cadence: 'every five minutes at UTC minute 01/06/11...',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'data-sync',
    successPredicate: 'complete fpl:price-changes publication and deliver Redis pointer',
    manualTrigger: true,
    resolve: async (context) => {
      const bucket = Math.floor((context.now.getTime() - offsetMs) / periodMs);
      const dueAt = new Date(bucket * periodMs + offsetMs);
      if (context.now < dueAt) return [];
      return [
        {
          scopeKey: context.season.seasonCode,
          periodKey: `price-change-${bucket}`,
          dueAt,
          source: 'catchup' as const,
          evidence: { cadence: 'five-minute', offsetMs },
        },
      ];
    },
    enqueue: async ({ context, obligationId, generation }) => {
      const job = await enqueuePriceChangePredictionsJob(context.season, 'catchup', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        removeOnSettle: false,
        obligationId,
        obligationGeneration: generation,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
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
      const event = await loadSchedulerEvent(context, context.currentEventId);
      if (!event) return [];
      const fixtures = await loadSchedulerFixtures(context, event.id);
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
    cadence: 'lifecycle-aware polling until the event is finalized',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'live-data',
    successPredicate: 'live snapshot checked and publication/durable rows advanced',
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const currentEvent = context.events.find((event) => event.id === context.currentEventId);
      if (!currentEvent?.deadlineTime) return [];
      const event = await loadSchedulerEvent(context, context.currentEventId);
      if (!event) return [];
      const fixtures = await loadSchedulerFixtures(context, event.id);
      const decision = decideLiveLifecycle(event, fixtures, context.now);
      // The permanent final checkpoint owns the finalized write. This lane
      // keeps the mutable official heartbeat alive for every unsettled state.
      if (!decision.shouldFetchLive || decision.state === 'FINALIZED') return [];
      const pollIntervalMs = resolveLiveLifecycleDelay(
        decision,
        context.season,
        event.id,
        context.now,
      );
      if (pollIntervalMs === null) return [];
      const bucket = Math.floor(context.now.getTime() / pollIntervalMs);
      const persistBucket = Math.floor(context.now.getTime() / (10 * 60_000));
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `live-${event.id}-${decision.state}-${pollIntervalMs}-${bucket}`,
          dueAt: new Date(bucket * pollIntervalMs),
          eventId: event.id,
          source: 'reconcile',
          evidence: {
            persistEventLives: context.now.getTime() % (10 * 60_000) < 30_000,
            persistBucket,
            lifecycleState: decision.state,
            pollIntervalMs,
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

type OfficialH2HSchedulerDependencies = Readonly<{
  findEvent: typeof eventRepository.findById;
  findFixtures: typeof fixtureRepository.findByEvent;
  hasPending: typeof hasPendingOfficialH2HJob;
  enqueue: typeof enqueueTournamentOfficialH2H;
}>;

export function officialH2HDefinition(
  dependencies?: OfficialH2HSchedulerDependencies,
): ScheduledJobDefinition {
  return {
    name: 'tournament-official-h2h-live',
    cadence: 'one-minute official H2H match-window sync',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'normal',
    queueName: 'tournament-sync',
    successPredicate: 'official H2H match snapshot and standings publish atomically',
    manualTrigger: false,
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const event = dependencies
        ? await dependencies.findEvent(context.season, context.currentEventId)
        : await loadSchedulerEvent(context, context.currentEventId);
      if (!event) return [];
      const fixtures = dependencies
        ? await dependencies.findFixtures(context.season, event.id)
        : await loadSchedulerFixtures(context, event.id);
      const matchDayTime = isMatchDayTime(event, fixtures, context.now);
      const decision = decideLiveLifecycle(event, fixtures, context.now, { matchDayTime });
      if (!shouldRefreshOfficialH2H(decision, matchDayTime)) return [];
      if (await (dependencies?.hasPending ?? hasPendingOfficialH2HJob)(context.season, event.id)) {
        return [];
      }
      const minuteStart = new Date(Math.floor(context.now.getTime() / 60_000) * 60_000);
      const minuteKey = minuteStart.toISOString().slice(0, 16).replace(/\D/g, '');
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `official-h2h-${event.id}-${minuteKey}`,
          dueAt: minuteStart,
          eventId: event.id,
          source: 'reconcile',
          evidence: { lifecycleState: decision.state },
        },
      ];
    },
    enqueue: async ({ context, plan, obligationId, generation }) => {
      const eventId = plan.eventId ?? context.currentEventId;
      if (!eventId) throw new Error('Official H2H obligation has no event checkpoint');
      const job = await (dependencies?.enqueue ?? enqueueTournamentOfficialH2H)(
        context.season,
        eventId,
        'reconcile',
        {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        },
      );
      if (!job) throw new Error('Official H2H job became pending before enqueue');
      return { bullJobId: job.id, runId: job.data.runId };
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
        ? await loadSchedulerEvent(context, context.currentEventId)
        : null;
      if (!current) return [];
      const fixtures = await loadSchedulerFixtures(context, current.id);
      const publication = await readCoreSnapshotCache(context.season.seasonCode);
      const active = await syncOperationsRepository.findActivePublication(
        'fpl:core',
        context.season,
      );
      const durablePublication = active
        ? await loadDataPublicationDelivery(active.publicationId).catch(() => null)
        : null;
      const reason = durablePublication
        ? coreSnapshotRefreshReason(current, fixtures, publication, context.now)
        : 'missing-publication';
      if (!reason) return [];
      return [
        {
          scopeKey: `${context.season.seasonCode}:core-lifecycle`,
          // Keep one durable obligation per canonical lifecycle target. A
          // succeeded repair for an earlier fixture transition must not block
          // the next started/provisional/final transition in this event.
          periodKey: coreLifecycleReconcilePeriodKey(current, fixtures, reason),
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
    executionLanes: ['queue:live-data', 'post-match-results'],
    claimPriority: 10,
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const event = await loadSchedulerEvent(context, context.currentEventId);
      if (!event) return [];
      const fixtures = await loadSchedulerFixtures(context, event.id);
      const checkpoint = getPostMatchResultsCheckpoint(event, fixtures, context.now);
      if (!checkpoint?.slot.startsWith('final-')) return [];
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `live-final-${event.id}-${checkpoint.slot}`,
          dueAt: checkpoint.dueAt,
          eventId: event.id,
          source: 'reconcile' as const,
          evidence: {
            resultSlot: checkpoint.slot,
            ...postMatchFixtureAuthority(fixtures),
            finalizeEvent: true,
            persistEventLives: true,
          },
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
    cadence: 'one-minute live/settling window; five-minute between-fixture/review repair',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'normal',
    queueName: 'data-sync',
    successPredicate: 'player stats for the active event persist for the current bucket',
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const event = await loadSchedulerEvent(context, context.currentEventId);
      if (!event) return [];
      const fixtures = await loadSchedulerFixtures(context, event.id);
      const decision = decideLiveLifecycle(event, fixtures, context.now);
      const cadence = resolvePlayerStatsActiveCadence(decision.state, context.now);
      if (!cadence) return [];
      const bucket = Math.floor(context.now.getTime() / 60_000);
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `player-stats-${event.id}-${bucket}`,
          dueAt: context.now,
          eventId: event.id,
          source: 'reconcile' as const,
          evidence: { lifecycleState: decision.state, cadence },
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
    priceChangePredictionsDefinition(),
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
    understatDailyDefinition({
      name: 'understat-team-incremental',
      hour: 11,
      minute: 15,
      queueName: 'understat-team-sync',
      successPredicate: 'Understat team incremental finalizer completes the daily lane',
      recoveryCompletionMode: 'understat-finalizer',
      enqueue: async ({ seasonCode, obligationId, generation }) => {
        if (!seasonCode) throw new Error('Understat team obligation has no season code');
        const result = await enqueueUnderstatTeamSync({
          season: seasonCode,
          mode: 'incremental',
          trigger: 'cron',
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: result.job.id, runId: result.runId };
      },
    }),
    understatDailyDefinition({
      name: 'understat-player-incremental',
      hour: 12,
      minute: 15,
      queueName: 'understat-player-sync',
      successPredicate: 'Understat player incremental finalizer completes the daily lane',
      recoveryCompletionMode: 'understat-finalizer',
      enqueue: async ({ seasonCode, obligationId, generation }) => {
        if (!seasonCode) throw new Error('Understat player obligation has no season code');
        const result = await enqueueUnderstatPlayerSync({
          season: seasonCode,
          mode: 'incremental',
          trigger: 'cron',
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: result.job.id, runId: result.runId };
      },
    }),
    understatOrphanReconcilerDefinition(),
    dailyDefinition({
      name: MAINTENANCE_JOBS.PLAYER_MARKET_FRESHNESS,
      hour: 9,
      minute: 36,
      cadence: 'daily',
      // The watchdog only knows how to validate today's mutable market date.
      // Missed historical windows are terminal evidence, never replayed as if
      // the current snapshot represented an older date.
      catchUpPolicy: 'current-day-only',
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
    myFplSnapshotDefinition(),
    myFplFinalizationDefinition(),
    myFplSnapshotOutboxDefinition(),
    dailyDefinition({
      name: 'entry-info',
      hour: 10,
      minute: 30,
      cadence: 'daily',
      catchUpPolicy: 'checkpoint',
      criticality: 'normal',
      queueName: 'entry-sync',
      successPredicate: 'entry info daily checkpoint advances',
      recoveryCompletionMode: 'entry-scan-finalizer',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueEntryInfoSyncJob(context.season, 'catchup', {
          eventId: resolveEntryInfoSnapshotTargetEventId(context),
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
      recoveryCompletionMode: 'entry-scan-finalizer',
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
      recoveryCompletionMode: 'entry-scan-finalizer',
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
    resultEventDefinition({
      name: 'entry-results',
      cadence: 'hourly after final fixture plus permanent final checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'normal',
      queueName: 'entry-sync',
      successPredicate: 'entry results checkpoint covers known entries for event',
      recoveryCompletionMode: 'entry-scan-finalizer',
      executionLanes: ['queue:entry-sync', 'post-match-results'],
      claimPriority: 20,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Entry results obligation has no event checkpoint');
        const job = await enqueueEntryResultsSyncJob(context.season, 'catchup', {
          eventId,
          freshAfter: plan.dueAt.toISOString(),
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
      successPredicate: 'league picks converge for every active tournament',
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
    resultEventDefinition({
      name: 'league-event-results',
      cadence: 'hourly after final fixture plus permanent final checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'critical',
      queueName: 'league-sync',
      successPredicate: 'league results converge for every active tournament',
      executionLanes: ['queue:league-sync', 'post-match-results'],
      claimPriority: 40,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('League results obligation has no event checkpoint');
        const job = await enqueueLeagueEventResults(context.season, eventId, 'catchup', {
          freshAfter: plan.dueAt.toISOString(),
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    resultEventDefinition({
      name: 'tournament-event-results',
      cadence: 'hourly after final fixture plus permanent final checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'critical',
      queueName: 'tournament-sync',
      successPredicate:
        'tournament result and cascade jobs enqueue; persistent barrier owns downstream completion',
      recoveryCompletionMode: 'tournament-cascade-finalizer',
      executionLanes: ['queue:tournament-sync', 'post-match-results'],
      claimPriority: 30,
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Tournament results obligation has no event checkpoint');
        const job = await enqueueTournamentEventResults(context.season, eventId, 'reconcile', {
          freshAfter: plan.dueAt.toISOString(),
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
    officialH2HDefinition(),
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
  const canonicalEvents = await eventRepository.findAll(season);
  const events = canonicalEvents
    .filter((event) => Number.isInteger(event.id) && event.id > 0)
    .map((event) => ({
      id: event.id,
      deadlineTime: event.deadlineTime ? new Date(event.deadlineTime) : null,
      finished: event.finished,
      dataChecked: event.dataChecked,
      dataCheckedAt: event.dataCheckedAt,
      updatedAt: event.updatedAt,
    }));
  const currentEvent = events
    .filter((event) => event.deadlineTime && event.deadlineTime.getTime() <= now.getTime())
    .sort(
      (left, right) => (right.deadlineTime?.getTime() ?? 0) - (left.deadlineTime?.getTime() ?? 0),
    )[0];
  const latestFinalizedEvent = canonicalEvents
    .filter((event) => event.finished && event.dataChecked)
    .sort((left, right) => right.id - left.id)[0];
  return {
    now,
    season,
    events,
    ...(currentEvent?.id ? { currentEventId: currentEvent.id } : {}),
    ...(currentEvent?.deadlineTime ? { currentEventDeadline: currentEvent.deadlineTime } : {}),
    ...(latestFinalizedEvent?.id ? { latestFinalizedEventId: latestFinalizedEvent.id } : {}),
  };
}

export const schedulerRegistry = createSchedulerRegistry();
