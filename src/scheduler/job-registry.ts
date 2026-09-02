import type { FplSeasonRef } from '../domain/fpl-season';
import type { Fixture } from '../types';
import { formatCronDateKey } from '../utils/timezone';
import {
  enqueueCoreSnapshotJob,
  enqueuePriceChangePredictionsJob,
  enqueuePlayerPricesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
} from '../jobs/data-sync-enqueue';
import { enqueueFplCriticalPriceChangeJob } from '../jobs/fpl-critical-sync-enqueue';
import { enqueueFplPriceWatchJob } from '../jobs/fpl-price-watch-enqueue';
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
  enqueueTournamentMaterializedViewsRefresh,
  enqueueTournamentOfficialH2H,
  enqueueTournamentRosterSync,
  enqueueTournamentTransfersPre,
  hasPendingOfficialH2HJob,
} from '../jobs/tournament-sync.jobs';
import { enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import { enqueueLivePicksRefresh } from '../jobs/live-picks.jobs';
import {
  enqueueBugReportCleanup,
  enqueueBugReportScreenshotRetention,
  enqueueClientSignalRetention,
  enqueueLaunchMonitor,
  enqueuePlayerMarketFreshness,
  enqueuePlayerSeasonSummaryRepair,
  enqueuePostMatchConsolidation,
  enqueueMyFplSnapshot,
  enqueueMyFplSnapshotOutbox,
  enqueueTournamentTrendsRepair,
  enqueueTournamentReview,
} from '../jobs/maintenance.jobs';
import { enqueueUnderstatPlayerSync, enqueueUnderstatTeamSync } from '../jobs/understat-enqueue';
import { enqueueUnderstatOrphanReconciler } from '../jobs/understat-recovery.jobs';
import { getPlayerValuesSchedulerQueueJobId } from '../jobs/player-values-settlement';
import { MAINTENANCE_JOBS } from '../queues/maintenance.queue';
import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import {
  coreLifecycleReconcilePeriodKey,
  coreSnapshotRefreshReason,
} from '../domain/core-snapshot-refresh';
import {
  getFinalizationAwarePostMatchResultsCheckpoint,
  getFinalizationAwarePostMatchResultsSlot,
} from '../domain/post-match-results';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { loadDataPublicationDelivery } from '../repositories/data-publication-outbox';
import { getSchedulerObligationByIdentity } from '../repositories/scheduler-obligations';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { isMatchDayTime } from '../utils/conditions';
import {
  decideLiveLifecycle,
  isLivePicksProbeDue,
  readLifecycleQuietState,
  resolveLiveLifecycleDelay,
  shouldRefreshOfficialH2H,
} from '../services/live-lifecycle-orchestrator';
import { normalizeMatchLifecycleState } from '../services/live-match-v3';
import {
  getMyFplSnapshotOperationalStatus,
  hasFinalMyFplPublication,
} from '../services/my-fpl-snapshot-publication.service';
import { getConfig, parseStrictBooleanEnvValue } from '../utils/config';
import { fplCriticalSyncQueueName } from '../queues/fpl-critical-sync.queue';
import { assertDataContractRegistry, contractForSchedulerJob } from '../domain/data-contracts';
import { fplPriceWatchQueueName } from '../queues/fpl-price-watch.queue';
import { getPriceChangePredictions } from '../services/price-change-predictions.service';
import { resolvePlayerSyncEvent } from '../services/player-sync-event.service';
import { logWarn } from '../utils/logger';
import { findLivePublicationV2FinalizationTargets } from '../services/live-publication-v2-checkpoint.service';
import {
  PRICE_CHANGE_WATCH_LEAD_MS,
  PRICE_CHANGE_WATCH_MAX_WINDOW_MS,
} from '../domain/price-change-watch-policy';

export type SchedulerSource = 'schedule' | 'catchup' | 'reconcile' | 'manual';
export type CatchUpPolicy =
  | 'current-day-only'
  | 'latest-authoritative'
  | 'checkpoint'
  | 'event-checkpoint'
  | 'none';

/**
 * Keep scheduler-owned queue overrides in the registry module so scheduler
 * admission, recovery, and status/catalog paths cannot disagree about the
 * effective lane.
 */
export function schedulerQueueLaneOverride(jobName: string): string | undefined {
  return jobName === 'my-fpl-finalization' ? 'my-fpl-orchestration' : undefined;
}

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
  /** Contract key is attached when the immutable registry is constructed. */
  contractKey?: string;
  cadence: string;
  timezone: string;
  catchUpPolicy: CatchUpPolicy;
  criticality: 'critical' | 'normal' | 'maintenance';
  queueName: string;
  executionPolicy?: Readonly<{
    kind: 'single-flight-latest';
    laneKey: (input: { context: SchedulerContext; plan: SchedulerObligationPlan }) => string;
    maxTargetsPerDispatch?: number;
  }>;
  successPredicate: string;
  /**
   * Bull completion evidence used only when recovering an expired scheduler
   * lease. Most workers settle the obligation from their root job, but
   * durable chains must reach their semantic finalizer first.
   */
  recoveryCompletionMode?:
    | 'root-job'
    | 'entry-scan-finalizer'
    | 'live-picks-finalizer'
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
    /** Exact freshness window being repaired, when dispatched by governance. */
    freshnessWindowId?: number;
    /** All freshness windows joined to one latest-wins publication. */
    freshnessWindowIds?: readonly number[];
    laneId?: string;
    dispatchGeneration?: number;
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

/**
 * Live Matches must observe the next scheduled event before its deadline. The
 * scheduler's canonical current event intentionally means the latest event
 * whose deadline has passed, so it cannot be the sole input for the
 * pre-deadline Match-only lane.
 */
export function selectLiveSnapshotEventIds(
  context: Pick<SchedulerContext, 'currentEventId' | 'events' | 'now'>,
): readonly number[] {
  const candidates = [
    ...(context.currentEventId ? [context.currentEventId] : []),
    ...context.events
      .filter(
        (event) =>
          event.id !== context.currentEventId &&
          event.deadlineTime !== null &&
          event.deadlineTime.getTime() > context.now.getTime(),
      )
      .sort(
        (left, right) =>
          (left.deadlineTime?.getTime() ?? Number.POSITIVE_INFINITY) -
          (right.deadlineTime?.getTime() ?? Number.POSITIVE_INFINITY),
      )
      .map((event) => event.id),
  ];
  return [...new Set(candidates)];
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
 * FPL marks an event finished, data_checked, and data_checked_at, a stable
 * final checkpoint remains eligible forever so scheduler downtime cannot
 * strand historical GWs. An event that has the boolean flags but not the
 * timestamp stays on a distinct provisional slot until complete finalization
 * evidence arrives.
 */
export async function resolvePostMatchResultPlans(
  context: SchedulerContext,
  loadFixtures: PostMatchFixturesLoader = (_season, eventId) =>
    loadSchedulerFixtures(context, eventId),
): Promise<readonly SchedulerObligationPlan[]> {
  const plans: SchedulerObligationPlan[] = [];
  const unsettledEvents: SchedulerContext['events'][number][] = [];

  for (const event of context.events) {
    if (event.finished === true && event.dataChecked === true && event.dataCheckedAt != null) {
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
      const checkpoint = getFinalizationAwarePostMatchResultsCheckpoint(
        event,
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

export function resolveLiveFinalizationCatchupPlans(
  context: SchedulerContext,
  targetEventIds: ReadonlySet<number>,
): readonly SchedulerObligationPlan[] {
  return context.events.flatMap((event) => {
    if (!targetEventIds.has(event.id) || event.dataCheckedAt == null) return [];

    const dueAt = event.dataCheckedAt;
    const resultAuthorityAtMs = (
      event.updatedAt ??
      event.dataCheckedAt ??
      event.deadlineTime ??
      dueAt
    ).getTime();
    return {
      scopeKey: `${context.season.seasonCode}:event:${event.id}`,
      periodKey: `live-final-catchup-${event.id}-${dueAt.getTime()}`,
      dueAt,
      eventId: event.id,
      source: 'catchup' as const,
      evidence: {
        finalization: 'missing-v2-checkpoint',
        resultSlot: 'final-checkpoint',
        resultAuthorityAtMs,
        resultScheduleAnchorMs: dueAt.getTime(),
        finalizeEvent: true,
        dataCheckedAt: event.dataCheckedAt?.toISOString() ?? null,
      },
    };
  });
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
      const plans = cached ?? resolvePostMatchResultPlans(context);
      if (!cached) postMatchPlanCache.set(context, plans);
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
    enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
      const eventId = plan.eventId;
      if (!eventId) throw new Error('My FPL snapshot obligation has no event checkpoint');
      const job = await enqueueMyFplSnapshot(context.season, 'catchup', {
        eventId,
        snapshotKind: 'PROVISIONAL',
        freshAfter: plan.dueAt.toISOString(),
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  };
}

/**
 * Keep the ordinary finalization identity stable for one source fence. A
 * repair fence is deliberately opt-in: it is derived from the terminal
 * obligation that needs delivery recovery, not from the publication produced
 * by a successful finalizer. This keeps normal 30-second passes idempotent
 * while still allowing a post-failure delivery repair to obtain a new row.
 */
export function myFplFinalizationPeriodKey(input: {
  eventId: number;
  dataCheckedAt: string;
  scopeFence: string;
  repairFence?: string | null;
}): string {
  const base = `final-${input.eventId}-${input.dataCheckedAt}-${input.scopeFence}`;
  const repairFence = input.repairFence?.trim();
  return repairFence ? `${base}-repair-${repairFence}` : base;
}

function myFplFinalizationDefinition(): ScheduledJobDefinition {
  return {
    name: 'my-fpl-finalization',
    cadence: '30-second finished + data_checked reconciliation',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'my-fpl-orchestration',
    successPredicate: 'final My FPL revision replaces the provisional revision',
    // FINAL is a read-only readiness check plus capture/outbox operation. It
    // must not wait behind provider refresh or the global tournament cascade;
    // missing checkpoints are deferred by the worker and repaired by their
    // own authoritative obligations.
    executionLanes: ['my-fpl-orchestration'],
    // A final checkpoint supersedes an older pending provisional snapshot.
    // The eventual provisional worker then observes the active FINAL revision
    // and exits without publishing stale authority.
    claimPriority: 45,
    resolve: async (context) => {
      const plans: SchedulerObligationPlan[] = [];
      const operationalStatuses = await getMyFplSnapshotOperationalStatus(
        context.season,
        context.now,
      );
      const statusByEventId = new Map(
        operationalStatuses.map((status) => [status.eventId, status]),
      );
      for (const event of context.events) {
        if (!event.finished || !event.dataChecked) continue;
        const checkedAt = event.dataCheckedAt?.toISOString() ?? 'unknown';
        const status = statusByEventId.get(event.id);
        // Include the current canonical scope fence in the durable identity.
        // A succeeded FINAL therefore cannot suppress a later correction when
        // entries or tournament memberships change after publication.
        const scopeFence = status
          ? [
              status.expectedEntryScopeSha256 ?? 'missing-entry-scope',
              status.expectedTournamentScopeSha256 ?? 'missing-tournament-scope',
              `na${status.expectedNotApplicableEntryCount ?? 0}`,
            ].join('-')
          : 'missing-status';
        const scopeKey = `${context.season.seasonCode}:event:${event.id}`;
        let periodKey = myFplFinalizationPeriodKey({
          eventId: event.id,
          dataCheckedAt: checkedAt,
          scopeFence,
        });
        let deliveryRecovery = false;
        // A terminal failure can be followed by a successful PostgreSQL and
        // Redis publication without changing the source fence or revision.
        // Only then create a repair identity, fenced by the failed row's
        // immutable UUID. A normal successful finalizer never changes this
        // identity on its next 30-second pass, and historical FINAL events
        // are not rekeyed merely because a scheduler process restarted.
        if (status?.settlementState === 'FINAL' && status.finalSla === 'MET') {
          const failedObligation = await getSchedulerObligationByIdentity({
            jobName: 'my-fpl-finalization',
            scopeKey,
            periodKey,
          });
          if (failedObligation?.status === 'irrecoverable') {
            const repairPeriodKey = myFplFinalizationPeriodKey({
              eventId: event.id,
              dataCheckedAt: checkedAt,
              scopeFence,
              repairFence: `${failedObligation.obligationId}-delivery-recovered`,
            });
            const repairObligation = await getSchedulerObligationByIdentity({
              jobName: 'my-fpl-finalization',
              scopeKey,
              periodKey: repairPeriodKey,
            });
            // The outbox delivery state is a transition fence: before Redis
            // delivery, finalSla is not MET; afterwards it is MET. Keep the
            // predecessor UUID in the identity so a later output revision
            // cannot manufacture a new obligation on every pass.
            if (repairObligation?.status === 'succeeded') continue;
            periodKey = repairPeriodKey;
            deliveryRecovery = true;
          }
        }
        plans.push({
          scopeKey,
          periodKey,
          dueAt: context.now,
          eventId: event.id,
          source: 'reconcile',
          evidence: {
            snapshotKind: 'FINAL',
            dataCheckedAt: checkedAt,
            ...(deliveryRecovery ? { reconciliation: 'delivery-recovered' } : {}),
            expectedEntryCount: status?.expectedEntryCount,
            expectedEntryScopeSha256: status?.expectedEntryScopeSha256,
            expectedNotApplicableEntryCount: status?.expectedNotApplicableEntryCount,
            expectedTournamentCount: status?.expectedTournamentCount,
            expectedTournamentScopeSha256: status?.expectedTournamentScopeSha256,
          },
        });
      }
      return plans;
    },
    enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
      const eventId = plan.eventId;
      if (!eventId) throw new Error('My FPL finalization obligation has no event checkpoint');
      const job = await enqueueMyFplSnapshot(context.season, 'reconcile', {
        eventId,
        snapshotKind: 'FINAL',
        freshAfter: plan.dueAt.toISOString(),
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
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
    periodPrefix: 'outbox',
    criticality: 'critical',
    successPredicate: 'committed My FPL Redis manifests are delivered or retried',
    enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
      const job = await enqueueMyFplSnapshotOutbox(context.season, 'catchup', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
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
  /** Stable identity prefix used by governance repair routing. */
  periodPrefix?: string;
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
          periodKey: `${input.periodPrefix ?? 'maintenance'}-${bucket}`,
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
  // This is intentionally evaluated at process startup. A deployment can
  // install the migration/worker first, then restart with the flag enabled;
  // changing it mid-process would make the registry's queue contract
  // ambiguous for obligations already reserved by that process.
  const singleFlightEnabled = parseStrictBooleanEnvValue(
    process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED,
    process.env.NODE_ENV !== 'production',
    'PRICE_CHANGE_SINGLE_FLIGHT_ENABLED',
  );
  return {
    name: 'price-change-predictions',
    cadence: 'every five minutes at UTC minute 01/06/11...',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: singleFlightEnabled ? fplCriticalSyncQueueName : 'data-sync',
    ...(singleFlightEnabled
      ? {
          executionPolicy: {
            kind: 'single-flight-latest' as const,
            laneKey: ({ plan }: { plan: SchedulerObligationPlan }) =>
              `fpl-price-changes-${plan.scopeKey}`,
            maxTargetsPerDispatch: 2,
          },
        }
      : {}),
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
    enqueue: async ({
      context,
      plan,
      obligationId,
      generation,
      freshnessWindowId,
      freshnessWindowIds,
      laneId,
      dispatchGeneration,
    }) => {
      const hotSourceOptions = {
        ...(typeof plan.evidence?.sourceHash === 'string'
          ? { sourceHash: plan.evidence.sourceHash }
          : {}),
        ...(typeof plan.evidence?.sourceArtifactId === 'string'
          ? { sourceArtifactId: plan.evidence.sourceArtifactId }
          : {}),
        ...(typeof plan.evidence?.priceChangeBoardRevision === 'string'
          ? { priceChangeBoardRevision: plan.evidence.priceChangeBoardRevision }
          : {}),
        ...(typeof plan.evidence?.sourceDetectedAt === 'string'
          ? { sourceDetectedAt: plan.evidence.sourceDetectedAt }
          : {}),
        ...(typeof plan.evidence?.sourceFetchedAt === 'string'
          ? { sourceFetchedAt: plan.evidence.sourceFetchedAt }
          : {}),
      };
      if (!singleFlightEnabled) {
        const job = await enqueuePriceChangePredictionsJob(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
          freshnessWindowIds,
          ...hotSourceOptions,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      }
      if (!laneId || dispatchGeneration === undefined) {
        throw new Error('Price-change single-flight enqueue requires a scheduler lane');
      }
      const source = plan.source === 'schedule' ? 'catchup' : plan.source;
      const job = await enqueueFplCriticalPriceChangeJob(context.season, source, {
        jobId: `scheduler-lane-${laneId}-g${dispatchGeneration}`,
        removeOnSettle: false,
        obligationId,
        obligationGeneration: generation,
        laneId,
        laneGeneration: dispatchGeneration,
        freshnessWindowId,
        freshnessWindowIds,
        ...hotSourceOptions,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  };
}

function priceHotWatchEnabled(): boolean {
  return parseStrictBooleanEnvValue(
    process.env.PRICE_CHANGE_HOT_WATCH_ENABLED,
    process.env.NODE_ENV !== 'production',
    'PRICE_CHANGE_HOT_WATCH_ENABLED',
  );
}

export function resolvePriceChangeWatchPlans(input: {
  readonly now: Date;
  readonly seasonCode: string;
  readonly deadlineCandidates: readonly string[];
  readonly watchWindowMs?: number;
}): readonly SchedulerObligationPlan[] {
  const nowMs = input.now.getTime();
  const watchWindowMs = input.watchWindowMs ?? PRICE_CHANGE_WATCH_MAX_WINDOW_MS;
  const deadline = input.deadlineCandidates
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value >= nowMs - watchWindowMs)
    .sort((left, right) => left - right)[0];
  if (deadline === undefined) return [];
  const deadlineAt = new Date(deadline);
  return [
    {
      scopeKey: input.seasonCode,
      periodKey: `price-change-watch-${deadline}`,
      dueAt: new Date(deadline - PRICE_CHANGE_WATCH_LEAD_MS),
      source: 'catchup',
      evidence: {
        deadlineAt: deadlineAt.toISOString(),
        leadMs: PRICE_CHANGE_WATCH_LEAD_MS,
        watchWindowMs,
      },
    },
  ];
}

function priceChangeWatchDefinition(): ScheduledJobDefinition {
  const watchWindowMs = PRICE_CHANGE_WATCH_MAX_WINDOW_MS;
  return {
    name: 'price-change-watch',
    cadence: 'deadline window (5 minutes before each official price-change deadline)',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: fplPriceWatchQueueName,
    executionLanes: [fplPriceWatchQueueName],
    isEnabled: priceHotWatchEnabled,
    successPredicate: 'observe an official price-change fingerprint or record no change',
    resolve: async (context) => {
      if (!priceHotWatchEnabled()) return [];
      // The durable board carries the latest authoritative deadline list. A
      // missing/stale board is handled by the normal price publication lane;
      // the scheduler must not make a provider request to discover an
      // optional hot-watch target.
      const board = await getPriceChangePredictions().catch(() => null);
      const nowMs = context.now.getTime();
      const deadlineCandidates =
        board && ['READY', 'STALE'].includes(board.status) ? board.nextDeadlines : [];
      const hasCandidateInWindow = deadlineCandidates.some((value) => {
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) && timestamp >= nowMs - watchWindowMs;
      });
      if (deadlineCandidates.length === 0 || !hasCandidateInWindow) {
        // The scheduler is a control-plane process. Do not make a provider
        // request here just to discover an optional hot-watch deadline: a
        // stale/missing board is evidence for the worker to observe on its
        // next durable cycle, not a reason to block every scheduler pass.
        logWarn('Price-watch deadline discovery unavailable from durable board', {
          season: context.season.seasonCode,
          boardStatus: board?.status ?? 'UNAVAILABLE',
        });
        return [];
      }
      return resolvePriceChangeWatchPlans({
        now: context.now,
        seasonCode: context.season.seasonCode,
        deadlineCandidates,
        watchWindowMs,
      });
    },
    enqueue: async ({ context, plan, obligationId, generation }) => {
      const rawDeadline = plan.evidence?.deadlineAt;
      if (typeof rawDeadline !== 'string') {
        throw new Error('Price-watch scheduler plan is missing deadlineAt evidence');
      }
      const deadlineAt = new Date(rawDeadline);
      const job = await enqueueFplPriceWatchJob(context.season, {
        deadlineAt,
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
        source: plan.source === 'manual' ? 'manual' : 'catchup',
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
      const resultSlot = getFinalizationAwarePostMatchResultsSlot(event, fixtures, context.now);
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
    enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
      const job = await enqueuePostMatchConsolidation(context.season, 'catchup', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
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
    successPredicate:
      'live snapshot checked; Redis publication current and checkpoint obligation reconciled',
    resolve: async (context) => {
      let selected:
        | {
            readonly event: NonNullable<Awaited<ReturnType<typeof loadSchedulerEvent>>>;
            readonly fixtures: Awaited<ReturnType<typeof loadSchedulerFixtures>>;
            readonly decision: ReturnType<typeof decideLiveLifecycle>;
          }
        | undefined;
      for (const eventId of selectLiveSnapshotEventIds(context)) {
        const event = await loadSchedulerEvent(context, eventId);
        if (!event?.deadlineTime) continue;
        const fixtures = await loadSchedulerFixtures(context, event.id);
        const decision = decideLiveLifecycle(event, fixtures, context.now);
        // The latest-deadline event owns the active pointer while its first
        // post-deadline picks probe is still pending. A scheduler pass inside
        // that one-second window must not skip it and publish the next event,
        // otherwise eventless readers can be advanced to a future gameweek.
        if (event.id === context.currentEventId && decision.state === 'PICKS_WAIT') {
          return [];
        }
        if (
          decision.state !== 'FINALIZED' &&
          (decision.shouldFetchLive || decision.shouldObserveMatches)
        ) {
          selected = { event, fixtures, decision };
          break;
        }
      }
      if (!selected) return [];
      const { event, decision } = selected;
      const quiet = await readLifecycleQuietState(context.season.seasonCode, event.id);
      // The permanent final checkpoint owns the finalized write. This lane
      // keeps the mutable official heartbeat alive for every unsettled state.
      // Match V3 observes the fixture desk before the Live Points source is
      // eligible to refresh.  Keep this scheduler lane alive for that
      // pre-kickoff observation; the worker still receives the lifecycle
      // state so unchanged observations do not fan out to downstream jobs.
      if (
        (!decision.shouldFetchLive && !decision.shouldObserveMatches) ||
        decision.state === 'FINALIZED'
      )
        return [];
      const pollIntervalMs = resolveLiveLifecycleDelay(
        decision,
        context.season,
        event.id,
        context.now,
        quiet?.unchangedSince,
      );
      if (pollIntervalMs === null) return [];
      const bucket = Math.floor(context.now.getTime() / pollIntervalMs);
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `live-${event.id}-${decision.state}-${pollIntervalMs}-${bucket}`,
          dueAt: new Date(bucket * pollIntervalMs),
          eventId: event.id,
          source: 'reconcile',
          evidence: {
            lifecycleState: decision.state,
            pollIntervalMs,
            expectedNextCheckAt: new Date(context.now.getTime() + pollIntervalMs).toISOString(),
            // Match V3 can warm the fixture desk before Live Points is
            // eligible. Preserve that lane on the durable obligation so the
            // reconciler cannot accidentally run the all-in-one producer.
            matchObservationOnly: decision.shouldObserveMatches && !decision.shouldFetchLive,
            promoteActiveEvent:
              decision.shouldObserveMatches &&
              !decision.shouldFetchLive &&
              decision.state !== 'PRE_DEADLINE',
          },
        },
      ];
    },
    enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
      const eventId = plan.eventId ?? context.currentEventId;
      if (!eventId) throw new Error('Live snapshot obligation has no event checkpoint');
      const job = await enqueueLiveSnapshot(context.season, eventId, 'reconcile', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        reuseExisting: true,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
        lifecycleState: normalizeMatchLifecycleState(plan.evidence?.lifecycleState),
        expectedNextCheckAt:
          typeof plan.evidence?.expectedNextCheckAt === 'string'
            ? plan.evidence.expectedNextCheckAt
            : null,
        matchObservationOnly: plan.evidence?.matchObservationOnly === true,
        ...(plan.evidence?.promoteActiveEvent === true ? { promoteActiveEvent: true } : {}),
      });
      return { bullJobId: job?.id, runId: job?.data?.runId };
    },
  };
}

function livePicksDefinition(): ScheduledJobDefinition {
  return {
    name: 'live-picks-refresh',
    cadence: 'deadline canary and live missing-entry repair',
    timezone: 'UTC',
    catchUpPolicy: 'latest-authoritative',
    criticality: 'critical',
    queueName: 'live-picks',
    executionLanes: ['queue:live-picks'],
    claimPriority: 5,
    successPredicate: 'canary accepted and eligible entry picks finalizer completes',
    recoveryCompletionMode: 'live-picks-finalizer',
    manualTrigger: false,
    resolve: async (context) => {
      if (!context.currentEventId) return [];
      const event = await loadSchedulerEvent(context, context.currentEventId);
      if (!event) return [];
      const fixtures = await loadSchedulerFixtures(context, event.id);
      const decision = decideLiveLifecycle(event, fixtures, context.now);
      if (!decision.shouldProbePicks && !decision.shouldSyncPicks) return [];
      if (!(await isLivePicksProbeDue(context.season.seasonCode, event.id, context.now))) return [];
      return [
        {
          scopeKey: `${context.season.seasonCode}:event:${event.id}`,
          periodKey: `live-picks-${event.id}-${Math.floor(context.now.getTime() / 30_000)}`,
          dueAt: context.now,
          eventId: event.id,
          source: 'reconcile' as const,
          evidence: {
            lifecycleState: decision.state,
            probe: decision.shouldProbePicks ? 'deadline-or-pre-start' : 'missing-input-repair',
          },
        },
      ];
    },
    enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
      const eventId = plan.eventId ?? context.currentEventId;
      if (!eventId) throw new Error('Live picks obligation has no event checkpoint');
      const job = await enqueueLivePicksRefresh(context.season, eventId, {
        jobId: `scheduler-${obligationId}-g${generation}`,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
        now: plan.dueAt,
      });
      return { bullJobId: job.id };
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
    criticality: 'critical',
    queueName: 'tournament-sync',
    executionLanes: ['queue:official-h2h-live'],
    claimPriority: 15,
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
    enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
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
          freshnessWindowId,
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
    enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
      const job = await enqueueCoreSnapshotJob(context.season, 'reconcile', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        removeOnSettle: false,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
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
      const targetIds = new Set(await findLivePublicationV2FinalizationTargets(context.season));
      return resolveLiveFinalizationCatchupPlans(context, targetIds);
    },
    enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
      const eventId = plan.eventId ?? context.currentEventId;
      if (!eventId) throw new Error('Live finalization obligation has no event checkpoint');
      const job = await enqueueLiveSnapshot(context.season, eventId, 'reconcile', {
        jobId: `scheduler-${obligationId}-g${generation}`,
        finalizeEvent: true,
        reuseExisting: true,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
      });
      return { bullJobId: job?.id, runId: job?.data?.runId };
    },
  };
}

export function playerPricesDefinition(
  resolveSyncEvent: typeof resolvePlayerSyncEvent = resolvePlayerSyncEvent,
): ScheduledJobDefinition {
  const definition = dailyDefinition({
    name: 'player-prices',
    hour: 7,
    minute: 10,
    cadence: 'daily',
    catchUpPolicy: 'current-day-only',
    criticality: 'normal',
    queueName: 'data-sync',
    successPredicate: 'current-day persisted player price changes replayed',
    enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
      const job = await enqueuePlayerPricesSyncJob(context.season, 'catchup', {
        changeDate: plan.periodKey,
        jobId: `scheduler-${obligationId}-g${generation}`,
        removeOnSettle: false,
        obligationId,
        obligationGeneration: generation,
        freshnessWindowId,
      });
      return { bullJobId: job.id, runId: job.data.runId };
    },
  });

  return {
    ...definition,
    resolve: async (context) => {
      if (!(await resolveSyncEvent(context.season, context.now))) return [];
      return definition.resolve(context);
    },
  };
}

export function createSchedulerRegistry(): readonly ScheduledJobDefinition[] {
  const definitions: ScheduledJobDefinition[] = [
    coreLifecycleReconcileDefinition(),
    priceChangePredictionsDefinition(),
    priceChangeWatchDefinition(),
    dailyDefinition({
      name: 'core-snapshot',
      hour: 6,
      minute: 35,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'critical',
      queueName: 'data-sync',
      successPredicate: 'core publication active for current authoritative event',
      enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
        const job = await enqueueCoreSnapshotJob(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    dailyDefinition({
      name: 'market-daily',
      hour: 6,
      minute: 55,
      cadence: 'daily',
      catchUpPolicy: 'current-day-only',
      criticality: 'critical',
      queueName: 'data-sync',
      successPredicate: 'complete market snapshot and delivered publication',
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const syncEvent = await resolvePlayerSyncEvent(context.season, context.now);
        const job = await enqueuePlayerValuesSyncJob(context.season, 'catchup', {
          changeDate: plan.periodKey,
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
          pollUntilWindowEnd: syncEvent?.phase === 'current',
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    playerPricesDefinition(),
    dailyDefinition({
      name: 'player-stats',
      hour: 9,
      minute: 40,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'normal',
      queueName: 'data-sync',
      successPredicate: 'current or latest event player stats persisted',
      enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
        const job = await enqueuePlayerStatsSyncJob(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      hour: 7,
      minute: 6,
      cadence: 'daily',
      // The watchdog only knows how to validate today's mutable market date.
      // Missed historical windows are terminal evidence, never replayed as if
      // the current snapshot represented an older date.
      catchUpPolicy: 'current-day-only',
      criticality: 'normal',
      queueName: 'maintenance',
      successPredicate: 'market freshness watchdog verifies a complete current snapshot',
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const marketDailyObligation = await getSchedulerObligationByIdentity({
          jobName: 'market-daily',
          scopeKey: context.season.seasonCode,
          periodKey: plan.periodKey,
        });
        const playerValuesBullJobId = marketDailyObligation
          ? getPlayerValuesSchedulerQueueJobId(context.season, marketDailyObligation)
          : undefined;
        const job = await enqueuePlayerMarketFreshness(context.season, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
          ...(playerValuesBullJobId ? { playerValuesBullJobId } : {}),
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
    dailyDefinition({
      name: MAINTENANCE_JOBS.CLIENT_SIGNAL_RETENTION,
      hour: 3,
      minute: 30,
      cadence: 'daily',
      catchUpPolicy: 'latest-authoritative',
      criticality: 'maintenance',
      queueName: 'maintenance',
      successPredicate:
        'anonymous client signal windows and idempotency batches stay within retention',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueClientSignalRetention(context.season, 'catchup', {
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
      name: MAINTENANCE_JOBS.TOURNAMENT_REVIEW,
      cadence: 'every five minutes; finalized scopes only',
      periodMs: 5 * 60_000,
      criticality: 'critical',
      successPredicate:
        'finalized My Tournament Review V2 scopes are published or retained in bounded repair',
      enqueue: async ({ context, obligationId, generation }) => {
        const job = await enqueueTournamentReview(context.season, 'catchup', {
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
      enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
        const job = await enqueueEntryInfoSyncJob(context.season, 'catchup', {
          eventId: resolveEntryInfoSnapshotTargetEventId(context),
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
        const job = await enqueueTournamentRosterSync(context.season, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, obligationId, generation, freshnessWindowId }) => {
        const job = await enqueueTournamentInfo(context.season, 0, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Entry picks obligation has no event checkpoint');
        const job = await enqueueEntryPicksSyncJob(context.season, 'catchup', {
          eventId,
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Entry transfers obligation has no event checkpoint');
        const event = context.events.find((candidate) => candidate.id === eventId);
        const job = await enqueueEntryTransfersSyncJob(context.season, 'catchup', {
          eventId,
          // A transfer scan can run before FPL marks the event final. When the
          // finalization fence is already present, carry it into the existing
          // rate-limited job so a pre-fence checkpoint cannot satisfy the
          // FINAL readiness gate.
          ...(event?.dataCheckedAt ? { freshAfter: event.dataCheckedAt.toISOString() } : {}),
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Entry results obligation has no event checkpoint');
        const job = await enqueueEntryResultsSyncJob(context.season, 'catchup', {
          eventId,
          freshAfter: plan.dueAt.toISOString(),
          jobId: `scheduler-${obligationId}-g${generation}`,
          removeOnSettle: false,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('League picks obligation has no event checkpoint');
        const job = await enqueueLeagueEventPicks(context.season, eventId, 'catchup', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('League results obligation has no event checkpoint');
        const job = await enqueueLeagueEventResults(context.season, eventId, 'catchup', {
          freshAfter: plan.dueAt.toISOString(),
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Tournament results obligation has no event checkpoint');
        const job = await enqueueTournamentEventResults(context.season, eventId, 'reconcile', {
          freshAfter: plan.dueAt.toISOString(),
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
        });
        return { bullJobId: job.id, runId: job.data.runId };
      },
    }),
    {
      name: 'tournament-materialized-views-refresh',
      cadence: 'after tournament setup commit or cascade barrier',
      timezone: 'UTC',
      catchUpPolicy: 'none',
      criticality: 'normal',
      queueName: 'tournament-sync',
      // Setup-owned refreshes are persisted directly by the setup transaction;
      // the definition is intentionally a delivery/recovery target rather
      // than a second recurring schedule.
      executionLanes: ['queue:tournament-sync'],
      claimPriority: 35,
      successPredicate: 'tournament materialized views refresh completes',
      recoveryCompletionMode: 'root-job',
      manualTrigger: false,
      resolve: async () => [],
      enqueue: async ({ context, plan, obligationId, generation }) => {
        const tournamentId = plan.evidence?.tournamentId;
        if (!Number.isSafeInteger(tournamentId) || Number(tournamentId) <= 0) {
          throw new Error('Tournament materialized-view obligation is missing tournamentId');
        }
        const eventId = plan.eventId ?? context.currentEventId ?? 0;
        const job = await enqueueTournamentMaterializedViewsRefresh(
          context.season,
          eventId,
          'reconcile',
          {
            tournamentId: Number(tournamentId),
            jobId: `scheduler-${obligationId}-g${generation}`,
            obligationId,
            obligationGeneration: generation,
          },
        );
        return { bullJobId: job.id, runId: job.data.runId };
      },
    },
    eventDefinition({
      name: 'tournament-event-picks',
      cadence: 'post-deadline event checkpoint',
      catchUpPolicy: 'event-checkpoint',
      criticality: 'normal',
      queueName: 'tournament-sync',
      successPredicate: 'tournament picks checkpoint advances',
      allDueEvents: true,
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Tournament picks obligation has no event checkpoint');
        const job = await enqueueTournamentEventPicks(context.season, eventId, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
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
      enqueue: async ({ context, plan, obligationId, generation, freshnessWindowId }) => {
        const eventId = plan.eventId ?? context.currentEventId;
        if (!eventId) throw new Error('Tournament transfers obligation has no event checkpoint');
        const job = await enqueueTournamentTransfersPre(context.season, eventId, 'reconcile', {
          jobId: `scheduler-${obligationId}-g${generation}`,
          obligationId,
          obligationGeneration: generation,
          freshnessWindowId,
        });
        return {
          bullJobId: job.id ?? `scheduler-${obligationId}-g${generation}`,
          runId: job.data.runId,
        };
      },
    }),
    liveSnapshotDefinition(),
    livePicksDefinition(),
    officialH2HDefinition(),
    liveFinalizationDefinition(),
    contentDefinition(),
  ];
  assertDataContractRegistry(definitions.map((definition) => definition.name));
  return definitions.map((definition) => ({
    ...definition,
    contractKey: contractForSchedulerJob(definition.name)?.contractKey,
  }));
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
