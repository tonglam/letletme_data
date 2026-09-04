import { randomUUID } from 'node:crypto';
import { seasonRepository } from '../repositories/seasons';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { Queue } from 'bullmq';
import { enqueueFplCriticalCoreRepairJob } from '../jobs/fpl-critical-sync-enqueue';

import {
  claimSchedulerObligations,
  confirmSchedulerObligationEnqueued,
  deferSchedulerObligationByIdentity,
  deferSchedulerObligationForAdmission,
  findDueSchedulerObligationCandidates,
  hasEarlierInFlightSchedulerObligation,
  markSchedulerObligationIrrecoverable,
  mergeSchedulerObligationEvidence,
  reconcilePostMatchSchedulerObligations,
  reserveSchedulerObligation,
  supersedeSchedulerObligations,
  supersedeSchedulerObligationsByDueAt,
  type SchedulerObligation,
} from '../repositories/scheduler-obligations';
import {
  failSchedulerObligation,
  recordCheckpointFreshnessEvidence,
} from '../services/scheduler-obligation-lifecycle.service';
import {
  advanceSchedulerLane,
  claimSchedulerLaneDispatch,
  confirmSchedulerLaneEnqueued,
  failSchedulerLaneDispatch,
  getSchedulerLane,
  getSchedulerLaneTarget,
  getSchedulerLaneTargets,
  recoverSchedulerLaneAfterBullLoss,
  unblockSchedulerLane,
  type SchedulerLane,
} from '../repositories/scheduler-lanes';
import {
  resolveSchedulerContext,
  schedulerQueueLaneOverride,
  schedulerRegistry,
  type ScheduledJobDefinition,
  type SchedulerContext,
  type SchedulerObligationPlan,
} from './job-registry';
import { latestActiveSchedulerPlansByScope } from './plan-coalescing';
import { MAINTENANCE_JOB_LANES } from '../jobs/maintenance.jobs';
import { QueueDrainOnlyError, readQueueAdmission } from '../services/queue-governance.service';
import {
  attachFreshnessWindowToSchedulerObligation,
  upsertFreshnessWindow,
} from '../services/data-governance.service';
import { getConfig } from '../utils/config';
import { mapWithConcurrency, TimeoutError, withTimeout } from '../utils/async';
import { logError, logInfo } from '../utils/logger';
import { safeDataErrorCode } from '../domain/error-classification';
import {
  contractForSchedulerJob,
  contractHasConsumerEvidence,
  contractHasFreshnessWindow,
} from '../domain/data-contracts';
import {
  advanceSchedulerProgress,
  completeSchedulerProgress,
  createSchedulerProgress,
  readSchedulerProgress,
  writeSchedulerProgress,
  tryWriteSchedulerProgress,
} from './scheduler-progress';
import {
  reconcileExpiredSchedulerEnqueueClaims,
  type SchedulerEnqueueRecoveryResult,
} from './scheduler-enqueue-recovery';
import { getQueueConnection } from '../utils/queue';
import { notifyTwoBots } from '../utils/notify';

// Definitions intentionally resolve the same durable checkpoint on every
// 30-second pass. Once this process has successfully reserved a plan, repeated
// INSERT ON CONFLICT reads add no recovery value because claiming below remains
// database-driven. The terminal status is part of the key: a current-day plan
// observed as active must still be revisited as irrecoverable after its window.
const MAX_OBSERVED_PLAN_KEYS = 20_000;
// A cold restart may expose dozens of durable checkpoints at once. Keep the
// admission burst near the three-connection runtime DB pool while lane locks
// prevent later passes from stacking more work behind an active lane.
const MAX_SCHEDULER_CLAIMS_PER_PASS = 4;
const UNDERSTAT_SCHEDULER_GENERATION_CAP = 3;
const UNDERSTAT_IN_FLIGHT_DEFER_MS = 60_000;
const UNDERSTAT_LATEST_AUTHORITATIVE_JOBS = [
  'understat-team-incremental',
  'understat-player-incremental',
] as const;
const UNDERSTAT_SCHEDULER_JOB_NAMES = [
  ...UNDERSTAT_LATEST_AUTHORITATIVE_JOBS,
  'understat-orphan-reconciler',
] as const;
const POST_MATCH_LATEST_AUTHORITATIVE_JOBS = [
  'live-finalization',
  'entry-results',
  'league-event-results',
  'tournament-event-results',
] as const;
const observedPlanKeys = new Map<string, true>();

// A definition resolver may still be unwinding after its bounded caller
// timeout (for example, a driver socket that has not observed cancellation
// yet). Coalesce that underlying operation per definition so the next 30s
// pass cannot create another identical provider/DB request while the first is
// still in flight. The entry is removed only after the actual resolver
// settles; each pass still gets its own bounded timeout around that promise.
const definitionResolutionInFlight = new WeakMap<
  ScheduledJobDefinition,
  Promise<readonly SchedulerObligationPlan[]>
>();

function evidenceNumber(evidence: Readonly<Record<string, unknown>> | undefined, key: string) {
  const value = evidence?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function evidenceString(evidence: Readonly<Record<string, unknown>> | undefined, key: string) {
  const value = evidence?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function hotSourcePeriodIdentity(options: {
  readonly sourceHash?: string;
  readonly sourceArtifactId?: string;
  readonly priceChangeBoardRevision?: string;
  readonly sourceDetectedAt?: string;
}): string | undefined {
  const identity =
    options.sourceHash ?? options.priceChangeBoardRevision ?? options.sourceArtifactId;
  if (!identity) return undefined;
  const detectedAtMs = options.sourceDetectedAt ? Date.parse(options.sourceDetectedAt) : NaN;
  // ISO timestamps are chronologically ordered when normalized, but a fixed
  // millisecond prefix keeps the period key's tie-break deterministic even if
  // callers use different valid ISO offsets. The source identity remains in
  // the suffix so repeated callbacks for one capture still coalesce.
  return Number.isFinite(detectedAtMs)
    ? `${String(detectedAtMs).padStart(13, '0')}-${identity}`
    : identity;
}

/**
 * A scheduler restart can observe a terminal obligation that was completed by
 * an older runtime before freshness evidence was wired through the payload.
 * Creating a brand-new pending SLO window for that historical completion would
 * manufacture a breach that no producer can ever fill. Terminal obligations
 * are therefore eligible for a new window only when they already carry an
 * exact window identity; active/failed obligations still create the window so
 * their next generation can settle it normally.
 */
export function shouldCreateFreshnessWindowForObligation(
  obligation?: Pick<SchedulerObligation, 'status' | 'evidence' | 'runId' | 'completedAt'>,
): boolean {
  if (!obligation) return true;
  if (!['succeeded', 'skipped', 'irrecoverable'].includes(obligation.status)) return true;
  return freshnessWindowIdsFromEvidence(obligation.evidence).length > 0;
}

/**
 * Create the durable SLO window at the same point that the scheduler records
 * the obligation.  The window is an evidence ledger, not a success marker:
 * downstream publication and consumer probes fill the milestone columns and
 * the observer settles the status later.  A missing/temporarily unavailable
 * governance table must not prevent the business obligation from being
 * reserved, so the write is deliberately best-effort during rolling rollout.
 */
async function recordFreshnessWindowForPlan(
  definition: ScheduledJobDefinition,
  plan: SchedulerObligationPlan,
  seasonId: number,
  obligation?: Pick<SchedulerObligation, 'status' | 'evidence' | 'runId' | 'completedAt'>,
): Promise<number | null> {
  // The price watcher is an observation obligation. It may publish a hot
  // board, or legitimately observe that the official provider did not change
  // prices, without producing a durable PostgreSQL publication for this
  // particular watch. Keep it out of the publication-SLO denominator; the
  // durable price-change lane owns the publication window.
  if (definition.name === 'price-change-watch') return null;
  // A pre-kickoff Match-only observation publishes the independent Match V3
  // desk and must not reserve or inherit a Live Points freshness window.
  if (definition.name === 'live-snapshot' && plan.evidence?.matchObservationOnly === true) {
    return null;
  }
  const contract = contractForSchedulerJob(definition.name);
  if (
    !contract ||
    contract.visibility === 'excluded' ||
    !contractHasFreshnessWindow(contract, definition.name)
  )
    return null;
  if (!shouldCreateFreshnessWindowForObligation(obligation)) return null;
  const eligibleAtMs = evidenceNumber(plan.evidence, 'eligibleAtMs') ?? plan.dueAt.getTime();
  const eligibleAt = new Date(eligibleAtMs);
  // The freshness deadline is end-to-end: the scheduler must dispatch within
  // the dispatch budget and the producer must finish within its execution
  // budget. A dispatch-only deadline would breach every long-running but
  // healthy producer before it had a chance to publish evidence.
  const dueAt = new Date(
    plan.dueAt.getTime() + contract.dispatchWithinMs + contract.executionBudgetMs,
  );
  if (!Number.isFinite(eligibleAt.getTime()) || !Number.isFinite(dueAt.getTime())) return null;
  const explicitSourceDay = evidenceString(plan.evidence, 'sourceDay');
  const sourceDay =
    explicitSourceDay ??
    (definition.name === 'market-daily' && /^\d{8}$/.test(plan.periodKey)
      ? `${plan.periodKey.slice(0, 4)}-${plan.periodKey.slice(4, 6)}-${plan.periodKey.slice(6, 8)}`
      : undefined);
  const windowId = await upsertFreshnessWindow({
    sloKey: contract.contractKey,
    contractKey: contract.contractKey,
    seasonId,
    scopeKey: plan.scopeKey,
    periodKey: plan.periodKey,
    ...(plan.eventId === undefined ? {} : { eventId: plan.eventId }),
    ...(sourceDay ? { sourceDay } : {}),
    eligibleAt,
    dueAt,
    obligationDueAt: plan.dueAt,
    evidence: {
      freshnessEvidence: contract.freshnessEvidence,
      // Freeze whether this window participates in the consumer-visible SLO
      // at reservation time. Internal/checkpoint contracts without a named
      // GraphQL+Web path must remain producer-only even after probes are
      // enabled globally.
      consumerEvidenceRequired:
        getConfig().FRESHNESS_CONSUMER_PROBES_ENABLED && contractHasConsumerEvidence(contract),
      redisEvidenceRequired:
        contract.freshnessEvidence === 'publication' || Boolean(contract.consumerEvidence.redis),
    },
  }).catch((error) => {
    logError('Freshness window reservation evidence failed', error, {
      contractKey: contract.contractKey,
      jobName: definition.name,
      scopeKey: plan.scopeKey,
      periodKey: plan.periodKey,
    });
    return null;
  });
  if (
    windowId !== null &&
    obligation &&
    obligation.status === 'succeeded' &&
    contract.freshnessEvidence === 'checkpoint'
  ) {
    // The exact window identity may have been attached by a previous runtime,
    // while the successful completion callback ran before that attachment.
    // Re-apply the durable checkpoint evidence using the obligation's retained
    // counts/revision. Failed or irrecoverable rows are deliberately excluded:
    // their timestamps prove an attempt, not a successful checkpoint. The
    // helper keeps a historical breach immutable and records recovery
    // separately, so this cannot turn a late repair into an on-time MET result.
    await recordCheckpointFreshnessEvidence({
      jobName: definition.name,
      evidence: { ...obligation.evidence, freshnessWindowId: windowId },
      completedAt: obligation.completedAt,
      runId: obligation.runId,
    }).catch((error) => {
      logError('Terminal checkpoint freshness backfill failed', error, {
        jobName: definition.name,
        windowId,
      });
    });
  }
  return windowId;
}

export function freshnessWindowIdsFromEvidence(
  evidence: Readonly<Record<string, unknown>> | undefined,
): readonly number[] {
  const values: unknown[] = [];
  if (Array.isArray(evidence?.freshnessWindowIds)) values.push(...evidence.freshnessWindowIds);
  values.push(evidence?.freshnessWindowId);
  return [...new Set(values)].filter(
    (value): value is number =>
      typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
  );
}

function freshnessWindowIdFromEvidence(evidence: Readonly<Record<string, unknown>> | undefined) {
  return freshnessWindowIdsFromEvidence(evidence)[0];
}

export function schedulerPlanKey(
  definition: Pick<ScheduledJobDefinition, 'name'>,
  plan: Pick<SchedulerObligationPlan, 'scopeKey' | 'periodKey' | 'terminalStatus' | 'evidence'>,
): string {
  const identity: Array<string | number> = [
    definition.name,
    plan.scopeKey,
    plan.periodKey,
    plan.terminalStatus ?? 'active',
  ];
  const resultSlot = plan.evidence?.resultSlot;
  const resultAuthorityAtMs = plan.evidence?.resultAuthorityAtMs;
  const resultScheduleAnchorMs = plan.evidence?.resultScheduleAnchorMs;
  if (
    typeof resultSlot === 'string' &&
    /^(provisional|final)-\d+$/.test(resultSlot) &&
    Number.isSafeInteger(resultAuthorityAtMs) &&
    Number(resultAuthorityAtMs) > 0 &&
    Number.isSafeInteger(resultScheduleAnchorMs) &&
    Number(resultScheduleAnchorMs) > 0
  ) {
    identity.push(Number(resultScheduleAnchorMs));
    identity.push(Number(resultAuthorityAtMs));
  }
  const eventPriority = plan.evidence?.eventPriority;
  if (
    definition.name === 'my-fpl-finalization' &&
    typeof eventPriority === 'number' &&
    Number.isSafeInteger(eventPriority) &&
    eventPriority >= 0
  ) {
    identity.push('eventPriority', eventPriority);
  }
  return JSON.stringify(identity);
}

export function postMatchReservationWasPersisted(
  plan: Pick<SchedulerObligationPlan, 'evidence'>,
  obligation: Pick<SchedulerObligation, 'evidence'> | undefined,
): boolean {
  if (!obligation) return false;
  const expectedSlot = plan.evidence?.resultSlot;
  if (typeof expectedSlot !== 'string') return false;
  if (!/^(provisional|final)-\d+$/.test(expectedSlot)) return true;
  return (
    obligation.evidence.resultSlot === expectedSlot &&
    obligation.evidence.resultAuthorityAtMs === plan.evidence?.resultAuthorityAtMs &&
    obligation.evidence.resultScheduleAnchorMs === plan.evidence?.resultScheduleAnchorMs
  );
}

function wasPlanObserved(key: string): boolean {
  if (!observedPlanKeys.has(key)) return false;
  observedPlanKeys.delete(key);
  observedPlanKeys.set(key, true);
  return true;
}

function rememberObservedPlan(key: string): void {
  observedPlanKeys.set(key, true);
  if (observedPlanKeys.size <= MAX_OBSERVED_PLAN_KEYS) return;
  const oldest = observedPlanKeys.keys().next().value;
  if (typeof oldest === 'string') observedPlanKeys.delete(oldest);
}

export type SchedulerPassResult = Readonly<{
  definitions: number;
  reserved: number;
  claimed: number;
  enqueued: number;
  failed: number;
}>;

export async function resolveSchedulerDefinition(
  definition: ScheduledJobDefinition,
  context: SchedulerContext,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<
  | Readonly<{ ok: true; plans: readonly SchedulerObligationPlan[] }>
  | Readonly<{ ok: false; error: unknown }>
> {
  try {
    const timeoutMs = options.timeoutMs ?? getConfig().SCHEDULER_RESOLVE_TIMEOUT_MS;
    let underlying = definitionResolutionInFlight.get(definition);
    if (!underlying) {
      const resolution = Promise.resolve().then(() => definition.resolve(context));
      const tracked = resolution.finally(() => {
        if (definitionResolutionInFlight.get(definition) === tracked) {
          definitionResolutionInFlight.delete(definition);
        }
      });
      underlying = tracked;
      definitionResolutionInFlight.set(definition, tracked);
    }
    const plans = await withTimeout(
      underlying,
      timeoutMs,
      `Scheduler definition ${definition.name} resolution exceeded ${timeoutMs}ms`,
    );
    return { ok: true, plans };
  } catch (error) {
    if (error instanceof TimeoutError) {
      const underlying = definitionResolutionInFlight.get(definition);
      if (underlying) {
        // A resolver may be backed by a driver operation that cannot be
        // cancelled by Promise.race. Keep the single-flight promise in the
        // map, but do not await it here: doing so would let one hung resolver
        // hold the entire 30-second scheduler pass forever. The next pass
        // will reuse the same underlying operation, time out independently,
        // and the progress/heartbeat stale guard can surface a real hang
        // without accumulating duplicate provider or database work.
        void underlying.catch(() => undefined);
      }
    }
    return { ok: false, error };
  }
}

/**
 * Manual price-change requests join the same latest-wins lane as the
 * scheduler. A caller receives the existing Bull ID when work is already
 * waiting/running/blocked; it never creates a parallel direct data-sync job.
 */
export async function triggerPriceChangeLane(
  options: {
    freshnessWindowId?: number;
    readonly sourceHash?: string;
    readonly sourceArtifactId?: string;
    readonly priceChangeBoardRevision?: string;
    readonly sourceDetectedAt?: string;
    readonly sourceFetchedAt?: string;
  } = {},
): Promise<{
  bullJobId?: string | number;
  runId?: string;
  /** Whether the request enqueued a new job or joined work already pending. */
  state: 'enqueued' | 'pending';
}> {
  const definition = definitionByName('price-change-predictions');
  if (!definition?.executionPolicy) {
    // The rollout flag deliberately keeps the legacy manual path available
    // until the critical queue has been deployed and enabled.
    throw new Error('Price-change latest-wins lane is disabled');
  }
  const season = await seasonRepository.findCurrent();
  const context = await resolveSchedulerContext(season, new Date());
  const resolution = await resolveSchedulerDefinition(definition, context);
  if (!resolution.ok) throw resolution.error;
  const resolvedPlan = resolution.plans
    .filter((candidate) => candidate.terminalStatus === undefined)
    .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())
    .at(-1);
  // Manual refreshes are allowed between cadence boundaries. Use the most
  // recently-started five-minute source bucket as the target waterline when
  // the schedule resolver correctly returns no future-due plan.
  const basePlan =
    resolvedPlan ??
    (() => {
      const periodMs = 5 * 60_000;
      const offsetMs = 60_000;
      const bucket = Math.floor((context.now.getTime() - offsetMs) / periodMs);
      const dueAt = new Date(bucket * periodMs + offsetMs);
      return {
        scopeKey: context.season.seasonCode,
        periodKey: `price-change-${bucket}`,
        dueAt,
        source: 'manual' as const,
        evidence: { cadence: 'five-minute', offsetMs, manual: true },
      };
    })();
  if (!basePlan) throw new Error('No current price-change scheduler target exists');
  const reconciliationEvidence =
    options.sourceHash ||
    options.sourceArtifactId ||
    options.priceChangeBoardRevision ||
    options.sourceDetectedAt ||
    options.sourceFetchedAt
      ? {
          ...(options.sourceHash ? { sourceHash: options.sourceHash } : {}),
          ...(options.sourceArtifactId ? { sourceArtifactId: options.sourceArtifactId } : {}),
          ...(options.priceChangeBoardRevision
            ? { priceChangeBoardRevision: options.priceChangeBoardRevision }
            : {}),
          ...(options.sourceDetectedAt ? { sourceDetectedAt: options.sourceDetectedAt } : {}),
          ...(options.sourceFetchedAt ? { sourceFetchedAt: options.sourceFetchedAt } : {}),
          reconciliation: 'price-change-hot',
        }
      : {};
  // A hot watcher may observe a price move after the ordinary five-minute
  // obligation is already running. Give each exact captured source its own
  // durable target instead of merging the evidence into the running row: the
  // source-evidence fence can then distinguish the late hot target from the
  // payload the worker already prepared. Repeated enqueue attempts for the
  // same source still coalesce because this identity is deterministic.
  const hotSourceIdentity = hotSourcePeriodIdentity(options);
  let plan: SchedulerObligationPlan = {
    ...basePlan,
    source: 'manual',
    ...(hotSourceIdentity ? { periodKey: `${basePlan.periodKey}-hot-${hotSourceIdentity}` } : {}),
    evidence: { ...(basePlan.evidence ?? {}), ...reconciliationEvidence },
  };
  let obligation = await reserveSchedulerObligation({
    definition,
    plan,
  });
  // The cadence identity is intentionally immutable once it has succeeded.
  // A later manual refresh must therefore get a new dispatchable obligation;
  // reusing the terminal five-minute row would make advanceSchedulerLane
  // correctly (but undesirably) report no work.
  // A hot reconciliation identity is immutable. Reusing the same captured
  // source must remain idempotent even after it has already settled; creating
  // a random manual suffix here would turn repeated watcher callbacks into
  // duplicate price publications. Ordinary manual refreshes retain their
  // historical re-run behavior and receive a fresh identity below.
  if (!hotSourceIdentity && ['succeeded', 'skipped', 'irrecoverable'].includes(obligation.status)) {
    const manualDueAt = new Date(Math.max(context.now.getTime(), plan.dueAt.getTime() + 1));
    const requestedAtMs = manualDueAt.getTime();
    plan = {
      ...plan,
      periodKey: `${plan.periodKey}-manual-${randomUUID()}`,
      dueAt: manualDueAt,
      evidence: {
        ...(plan.evidence ?? {}),
        manual: true,
        requestedAtMs,
      },
    };
    obligation = await reserveSchedulerObligation({ definition, plan });
  }
  if (Object.keys(reconciliationEvidence).length > 0) {
    obligation = await mergeSchedulerObligationEvidence({
      obligationId: obligation.obligationId,
      evidence: reconciliationEvidence,
    });
  }
  const laneKey = definition.executionPolicy.laneKey({ context, plan });
  const advanced = await advanceSchedulerLane({
    laneKey,
    jobName: definition.name,
    scopeKey: plan.scopeKey,
    queueName: definition.queueName,
    desiredObligation: obligation,
  });
  if (options.freshnessWindowId !== undefined) {
    await attachFreshnessWindowToSchedulerObligation({
      obligationId: advanced.lane.desiredObligationId,
      freshnessWindowId: options.freshnessWindowId,
    });
    if (!advanced.shouldDispatch && advanced.lane.activeObligationId) {
      // A latest-wins lane may already have a Bull job in flight. Updating the
      // desired row alone is not enough: the running worker loaded its Bull
      // payload before this repair joined the lane. Bind the exact window to
      // the active obligation too; the provider worker re-reads this fenced
      // evidence before preparing its publication.
      await attachFreshnessWindowToSchedulerObligation({
        obligationId: advanced.lane.activeObligationId,
        freshnessWindowId: options.freshnessWindowId,
      });
    }
  }
  if (!advanced.shouldDispatch) {
    return {
      ...(advanced.lane.bullJobId
        ? { bullJobId: advanced.lane.bullJobId }
        : advanced.lane.blockerJobId
          ? { bullJobId: advanced.lane.blockerJobId }
          : {}),
      ...(advanced.lane.runId ? { runId: advanced.lane.runId } : {}),
      state: 'pending',
    };
  }
  const dispatch = await claimSchedulerLaneDispatch({ laneId: advanced.lane.laneId });
  if (!dispatch) {
    const current = await getSchedulerLane({ laneId: advanced.lane.laneId });
    return {
      ...(current?.bullJobId
        ? { bullJobId: current.bullJobId }
        : current?.blockerJobId
          ? { bullJobId: current.blockerJobId }
          : {}),
      ...(current?.runId ? { runId: current.runId } : {}),
      state: 'pending',
    };
  }
  const target = await getSchedulerLaneTarget({ laneId: dispatch.lane.laneId });
  if (!target) throw new Error('Price-change lane target disappeared before manual enqueue');
  try {
    const result = await definition.enqueue({
      context,
      plan: {
        scopeKey: target.obligation.scopeKey,
        periodKey: target.obligation.periodKey,
        dueAt: target.obligation.dueAt,
        source: target.obligation.source,
        evidence: target.obligation.evidence,
      },
      obligationId: target.obligation.obligationId,
      generation: target.obligation.generation,
      laneId: dispatch.lane.laneId,
      dispatchGeneration: dispatch.lane.dispatchGeneration,
      freshnessWindowId: options.freshnessWindowId,
      freshnessWindowIds: freshnessWindowIdsFromEvidence(target.obligation.evidence),
    });
    if (result?.bullJobId === undefined)
      throw new Error('Manual price enqueue returned no Bull ID');
    const confirmed = await confirmSchedulerLaneEnqueued({
      laneId: dispatch.lane.laneId,
      owner: dispatch.owner,
      bullJobId: result.bullJobId,
      runId: result.runId,
      obligationId: target.obligation.obligationId,
      queueName: dispatch.lane.queueName,
    });
    if (!confirmed) throw new Error('Manual price lane enqueue confirmation CAS failed');
    return { ...result, state: 'enqueued' };
  } catch (error) {
    // An enqueue timeout can be ambiguous: Bull may have accepted the
    // deterministic job before the network response failed. Reconcile that
    // identity before releasing the short dispatch lease so a retry cannot
    // create a second runnable job.
    await reconcileSingleFlightBullState(dispatch.lane).catch((reconcileError) => {
      logError('Manual latest-wins enqueue ambiguity reconciliation failed', reconcileError, {
        laneId: dispatch.lane.laneId,
        dispatchGeneration: dispatch.lane.dispatchGeneration,
      });
    });
    const current = await getSchedulerLane({ laneId: dispatch.lane.laneId });
    if (current?.state === 'enqueued' || current?.state === 'running') {
      return {
        ...(current.bullJobId ? { bullJobId: current.bullJobId } : {}),
        ...(current.runId ? { runId: current.runId } : {}),
        state: 'pending',
      };
    }
    // A failed reconciliation means Redis did not give us a trustworthy
    // answer about the deterministic Bull identity. Releasing the dispatch
    // lease here could create a second runnable job, so report the request as
    // pending and let the scheduler reconcile it on the next pass.
    if (current?.state === 'dispatching') {
      return { state: 'pending' };
    }
    if (current?.state === 'idle' || current?.state === 'blocked') {
      return {
        ...(current.bullJobId
          ? { bullJobId: current.bullJobId }
          : current.blockerJobId
            ? { bullJobId: current.blockerJobId }
            : {}),
        ...(current.runId ? { runId: current.runId } : {}),
        state: 'pending',
      };
    }
    await failSchedulerLaneDispatch({ laneId: dispatch.lane.laneId, owner: dispatch.owner, error });
    throw error;
  }
}

let compatibilityPassInFlight: Promise<void> | null = null;

function definitionByName(name: string): ScheduledJobDefinition | undefined {
  return schedulerRegistry.find((definition) => definition.name === name);
}

async function reconcileSingleFlightBullState(
  lane: SchedulerLane,
  currentSeason?: Awaited<ReturnType<typeof seasonRepository.findCurrent>>,
): Promise<void> {
  // A Core mismatch moves the price lane to `blocked` before the repair job is
  // delivered. Reconcile that hand-off just like a price dispatch: a missing
  // deterministic repair is safe to re-add, while a transient Redis error is
  // deliberately surfaced so the caller cannot reclaim the lane lease.
  if (lane.state === 'blocked') {
    if (!lane.blockerJobId) {
      throw new Error(`Blocked scheduler lane ${lane.laneId} has no blocker Bull job ID`);
    }
    const queue = new Queue(lane.queueName, { connection: getQueueConnection() });
    try {
      const blocker = await queue.getJob(lane.blockerJobId);
      const state = blocker ? await blocker.getState() : 'missing';
      if (['waiting', 'delayed', 'active', 'paused', 'prioritized'].includes(state)) return;
      if (state === 'completed') {
        const unblocked = await unblockSchedulerLane({
          blockerJobId: lane.blockerJobId,
          success: true,
        });
        if (!unblocked) {
          throw new Error(`Scheduler lane blocker completion CAS failed for ${lane.laneId}`);
        }
        return;
      }
      if (state === 'failed') {
        const unblocked = await unblockSchedulerLane({
          blockerJobId: lane.blockerJobId,
          success: false,
          error: new Error('Core repair Bull job failed before lane unblock'),
        });
        if (!unblocked) {
          throw new Error(`Scheduler lane blocker failure CAS failed for ${lane.laneId}`);
        }
        return;
      }
      if (state !== 'missing') {
        throw new Error(`Unexpected Core repair Bull state ${state} for ${lane.laneId}`);
      }

      const season = currentSeason ?? (await seasonRepository.findCurrent());
      if (season.seasonCode !== lane.scopeKey) {
        throw new Error(
          `Cannot recover Core repair for ${lane.laneId}: lane scope ${lane.scopeKey} is not current season ${season.seasonCode}`,
        );
      }
      const expectedBlockerId = `${season.seasonCode}-core-snapshot-price-change-repair-${lane.laneId}-g${lane.dispatchGeneration}`;
      if (lane.blockerJobId !== expectedBlockerId) {
        throw new Error(
          `Core repair Bull ID mismatch for ${lane.laneId}: expected ${expectedBlockerId}, got ${lane.blockerJobId}`,
        );
      }
      const blockedTargets = await getSchedulerLaneTargets({ laneId: lane.laneId });
      const blockerEvidence =
        blockedTargets?.active?.evidence ?? blockedTargets?.desired?.evidence ?? {};
      const sourceHash = evidenceString(blockerEvidence, 'sourceHash');
      const sourceArtifactId = evidenceString(blockerEvidence, 'sourceArtifactId');
      const priceChangeBoardRevision = evidenceString(blockerEvidence, 'priceChangeBoardRevision');
      const sourceDetectedAt = evidenceString(blockerEvidence, 'sourceDetectedAt');
      const sourceFetchedAt = evidenceString(blockerEvidence, 'sourceFetchedAt');
      const repair = await enqueueFplCriticalCoreRepairJob(season, 'reconcile', {
        jobId: `core-snapshot-price-change-repair-${lane.laneId}-g${lane.dispatchGeneration}`,
        removeOnSettle: false,
        laneId: lane.laneId,
        laneGeneration: lane.dispatchGeneration,
        blockerLaneId: lane.laneId,
        ...(sourceHash ? { sourceHash } : {}),
        ...(sourceArtifactId ? { sourceArtifactId } : {}),
        ...(priceChangeBoardRevision ? { priceChangeBoardRevision } : {}),
        ...(sourceDetectedAt ? { sourceDetectedAt } : {}),
        ...(sourceFetchedAt ? { sourceFetchedAt } : {}),
      });
      if (String(repair.id) !== lane.blockerJobId) {
        throw new Error(
          `Core repair Bull ID mismatch after recovery: expected ${lane.blockerJobId}, got ${repair.id}`,
        );
      }
      logInfo('Recovered blocked price lane Core repair delivery', {
        laneId: lane.laneId,
        dispatchGeneration: lane.dispatchGeneration,
        blockerJobId: lane.blockerJobId,
        season: season.seasonCode,
      });
    } finally {
      await queue.close();
    }
    return;
  }
  if (lane.state === 'dispatching') {
    if (!lane.dispatchOwner) {
      throw new Error(`Dispatching scheduler lane ${lane.laneId} has no dispatch owner`);
    }
    const queue = new Queue(lane.queueName, { connection: getQueueConnection() });
    try {
      // Price lane enqueue IDs are deterministic. Recover a successful Redis
      // add even when the scheduler lost the response before its CAS write;
      // otherwise the two-minute dispatch lease would create a duplicate.
      // enqueueFplCriticalPriceChangeJob applies the season prefix through
      // getExplicitDataSyncQueueJobId; mirror that exact Bull identity when
      // recovering an enqueue whose response was lost.
      const expectedJobId = `${lane.scopeKey}-scheduler-lane-${lane.laneId}-g${lane.dispatchGeneration}`;
      const job = await queue.getJob(expectedJobId);
      const state = job ? await job.getState() : 'missing';
      if (['waiting', 'delayed', 'active', 'paused', 'prioritized'].includes(state)) {
        if (!job || job.id === undefined) throw new Error('Recovered Bull job has no ID');
        const confirmed = await confirmSchedulerLaneEnqueued({
          laneId: lane.laneId,
          owner: lane.dispatchOwner,
          bullJobId: job.id,
          runId: job.data?.runId,
          obligationId: job.data?.obligationId,
          queueName: lane.queueName,
        });
        if (!confirmed) {
          logError('Latest-wins dispatch recovery CAS failed', undefined, {
            laneId: lane.laneId,
            dispatchGeneration: lane.dispatchGeneration,
            bullJobId: job.id,
          });
        }
      }
      if (state === 'missing' || state === 'failed') {
        const recovered = await recoverSchedulerLaneAfterBullLoss({
          laneId: lane.laneId,
          dispatchGeneration: lane.dispatchGeneration,
          bullJobId: expectedJobId,
          bullState: state,
          obligationId: lane.desiredObligationId,
        });
        if (!recovered) {
          logError('Latest-wins dispatch loss recovery CAS failed', undefined, {
            laneId: lane.laneId,
            dispatchGeneration: lane.dispatchGeneration,
            bullJobId: expectedJobId,
            bullState: state,
          });
        }
        return;
      }
      if (state === 'completed') {
        await notifyTwoBots(
          [
            'Latest-wins lane completed before dispatch confirmation',
            `Lane: ${lane.laneKey}`,
            `Bull job: ${job?.id ?? expectedJobId}`,
          ].join('\n'),
          {
            idempotencyKey: `scheduler-lane-dispatch-completed:${lane.laneId}:${lane.dispatchGeneration}`,
          },
        ).catch(() => undefined);
        await failSchedulerLaneDispatch({
          laneId: lane.laneId,
          owner: lane.dispatchOwner,
          error: new Error('Bull job completed before dispatch confirmation'),
        });
      }
    } finally {
      await queue.close();
    }
    return;
  }
  if (!['enqueued', 'running'].includes(lane.state) || !lane.bullJobId) return;
  const queue = new Queue(lane.queueName, { connection: getQueueConnection() });
  try {
    const runnableJobs = await queue.getJobs(
      ['waiting', 'delayed', 'active', 'prioritized', 'paused'],
      0,
      -1,
    );
    const laneRunnableJobs = runnableJobs.filter(
      (job) => job.name === lane.jobName && job.data?.laneId === lane.laneId,
    );
    if (laneRunnableJobs.length > 1) {
      await notifyTwoBots(
        [
          'Critical: more than one runnable latest-wins price job',
          `Lane: ${lane.laneKey}`,
          `Runnable jobs: ${laneRunnableJobs.map((job) => job.id).join(', ')}`,
        ].join('\n'),
        {
          idempotencyKey: `scheduler-lane-runnable-duplicate:${lane.laneId}:${lane.dispatchGeneration}`,
        },
      ).catch(() => undefined);
    }
    const job = await queue.getJob(lane.bullJobId);
    const state = job ? await job.getState() : 'missing';
    if (lane.state === 'running' && Date.now() - lane.lastProgressAt.getTime() >= 2 * 60_000) {
      await notifyTwoBots(
        [
          'Latest-wins worker has made no progress for two minutes',
          `Lane: ${lane.laneKey}`,
          `Bull state: ${state}`,
        ].join('\n'),
        { idempotencyKey: `scheduler-lane-no-progress:${lane.laneId}:${lane.dispatchGeneration}` },
      ).catch(() => undefined);
    }
    if (state === 'missing' || state === 'failed') {
      const recovered = await recoverSchedulerLaneAfterBullLoss({
        laneId: lane.laneId,
        dispatchGeneration: lane.dispatchGeneration,
        bullJobId: lane.bullJobId,
        bullState: state,
      });
      if (recovered) {
        logInfo('Recovered latest-wins lane after Bull job loss', {
          laneId: lane.laneId,
          laneKey: lane.laneKey,
          bullState: state,
        });
      }
      return;
    }
    if (state === 'completed') {
      await notifyTwoBots(
        [
          'Latest-wins lane completed without durable completion',
          `Lane: ${lane.laneKey}`,
          `Bull job: ${lane.bullJobId}`,
        ].join('\n'),
        {
          idempotencyKey: `scheduler-lane-completion-missing:${lane.laneId}:${lane.dispatchGeneration}`,
        },
      ).catch(() => undefined);
      logError('Latest-wins lane Bull job completed without durable completion', undefined, {
        laneId: lane.laneId,
        bullJobId: lane.bullJobId,
      });
    }
  } finally {
    await queue.close();
  }
}

async function alertPriceLaneFreshness(
  lane: SchedulerLane,
  season: Awaited<ReturnType<typeof seasonRepository.findCurrent>>,
): Promise<void> {
  if (lane.jobName !== 'price-change-predictions') return;
  const desiredAgeMs = Date.now() - lane.desiredDueAt.getTime();
  const target = await getSchedulerLaneTarget({ laneId: lane.laneId });
  const targetPending = target
    ? ['pending', 'failed', 'enqueued', 'running'].includes(target.obligation.status)
    : false;
  if (targetPending && desiredAgeMs >= 6 * 60_000) {
    await notifyTwoBots(
      [
        'Price-change latest cycle has not published within six minutes',
        `Season: ${season.seasonCode}`,
        `Lane: ${lane.laneKey}`,
        `Lane state: ${lane.state}`,
      ].join('\n'),
      { idempotencyKey: `price-lane-lag:${lane.laneId}:${lane.desiredDueAt.toISOString()}` },
    ).catch(() => undefined);
  }
  const manifest = await syncOperationsRepository
    .findActivePublicationManifest('fpl:price-changes', season)
    .catch(() => null);
  const fetchedAt = manifest?.lastSuccessfulFetchAt ?? manifest?.sourceCheckedAt;
  const fetchedAtMs = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  const publicationAgeMs = Number.isFinite(fetchedAtMs)
    ? Math.max(0, Date.now() - fetchedAtMs)
    : null;
  if (
    (publicationAgeMs !== null && publicationAgeMs >= 10 * 60_000) ||
    (publicationAgeMs === null && targetPending && desiredAgeMs >= 10 * 60_000)
  ) {
    await notifyTwoBots(
      [
        'Critical: price-change publication is at least ten minutes old',
        `Season: ${season.seasonCode}`,
        `Publication: ${manifest?.publicationId ?? 'unknown'}`,
        `Revision: ${manifest?.revision ?? 'unknown'}`,
      ].join('\n'),
      {
        idempotencyKey: `price-publication-age:${season.seasonCode}:${manifest?.publicationId ?? 'none'}`,
      },
    ).catch(() => undefined);
  }
}

async function admissionDisabledSchedulerJobs(
  definitions: readonly ScheduledJobDefinition[],
): Promise<readonly string[]> {
  const checked = await Promise.all(
    definitions.map(async (definition) => {
      const lane = schedulerLaneName(definition);
      if (!lane) return null;
      const admission = await readQueueAdmission(lane);
      return admission?.mode === 'DRAIN_ONLY' ? definition.name : null;
    }),
  );
  return checked.filter((name): name is string => name !== null);
}

export function schedulerExecutionLanes(
  definition: Pick<ScheduledJobDefinition, 'name' | 'executionLanes' | 'queueName'>,
): readonly string[] {
  const configured = [...new Set(definition.executionLanes ?? [])].filter(
    (lane) => lane.trim().length > 0,
  );
  if (configured.length > 0) return configured.sort();
  return [`queue:${schedulerLaneName(definition)}`];
}

function schedulerLaneName(definition: Pick<ScheduledJobDefinition, 'name' | 'queueName'>): string {
  if (definition.name === 'tournament-official-h2h-live' && getConfig().QUEUE_LANES_V2_ENABLED) {
    return 'official-h2h-live';
  }
  const override = schedulerQueueLaneOverride(definition.name);
  if (override && getConfig().QUEUE_LANES_V2_ENABLED) return override;
  if (definition.queueName === 'maintenance' && getConfig().QUEUE_LANES_V2_ENABLED) {
    return (
      MAINTENANCE_JOB_LANES[definition.name as keyof typeof MAINTENANCE_JOB_LANES] ?? 'maintenance'
    );
  }
  return definition.queueName;
}

export function orderSchedulerDefinitionsForClaim(
  definitions: readonly ScheduledJobDefinition[],
): readonly ScheduledJobDefinition[] {
  return definitions
    .map((definition, index) => ({ definition, index }))
    .sort(
      (left, right) =>
        (left.definition.claimPriority ?? 100) - (right.definition.claimPriority ?? 100) ||
        left.index - right.index,
    )
    .map(({ definition }) => definition);
}

export type SchedulerDueCandidate = {
  jobName: string;
  /** Mutable retry eligibility timestamp. */
  earliestDueAt: Date;
  /** Immutable schedule boundary; old callers may omit it. */
  earliestScheduledDueAt?: Date;
};

type SchedulerCandidateTimes = {
  earliestDueAt: number;
  earliestScheduledDueAt: number;
};

export type SchedulerDueProgress = Readonly<{
  dueCount: number;
  lateCount: number;
  oldestUnfinishedDueAt: Date | null;
}>;

function aggregateSchedulerCandidateTimes(
  candidates: readonly SchedulerDueCandidate[],
): Map<string, SchedulerCandidateTimes> {
  const candidateTimes = new Map<string, SchedulerCandidateTimes>();
  for (const candidate of candidates) {
    const dueAt = candidate.earliestDueAt.getTime();
    if (!Number.isFinite(dueAt)) continue;
    const scheduledDueAt = candidate.earliestScheduledDueAt?.getTime() ?? dueAt;
    const effectiveScheduledDueAt = Number.isFinite(scheduledDueAt) ? scheduledDueAt : dueAt;
    const previous = candidateTimes.get(candidate.jobName);
    // Candidate queries normally return one row per job, but keeping the
    // earliest value here makes the ordering safe if a future query adds a
    // scope dimension or returns duplicate candidates. Retry due_at is only
    // used for eligibility/metrics; dispatch ordering must retain the
    // immutable schedule boundary so a deferred job cannot lose its place.
    candidateTimes.set(candidate.jobName, {
      earliestDueAt: Math.min(previous?.earliestDueAt ?? dueAt, dueAt),
      earliestScheduledDueAt: Math.min(
        previous?.earliestScheduledDueAt ?? effectiveScheduledDueAt,
        effectiveScheduledDueAt,
      ),
    });
  }
  return candidateTimes;
}

/**
 * Convert the claimer's grouped due candidates into the progress metrics shown
 * by the operations endpoint.  Keep this calculation pure so the pass-start
 * and post-pass refresh use identical dispatch-deadline semantics.
 */
export function schedulerDueProgress(
  definitions: readonly ScheduledJobDefinition[],
  candidates: readonly SchedulerDueCandidate[],
  now = new Date(),
): SchedulerDueProgress {
  const candidateTimes = aggregateSchedulerCandidateTimes(candidates);
  const knownDefinitions = new Set(definitions.map((definition) => definition.name));
  let lateCount = 0;
  for (const [jobName, times] of candidateTimes) {
    if (!knownDefinitions.has(jobName)) continue;
    const dispatchWithinMs = contractForSchedulerJob(jobName)?.dispatchWithinMs ?? 0;
    if (times.earliestScheduledDueAt + dispatchWithinMs < now.getTime()) lateCount += 1;
  }
  const oldest = [...candidateTimes.values()]
    .map((times) => times.earliestScheduledDueAt)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)[0];
  return {
    dueCount: candidateTimes.size,
    lateCount,
    oldestUnfinishedDueAt: oldest === undefined ? null : new Date(oldest),
  };
}

export function orderSchedulerDefinitionsByEarliestDue(
  definitions: readonly ScheduledJobDefinition[],
  candidates: readonly SchedulerDueCandidate[],
): readonly ScheduledJobDefinition[] {
  const candidateTimes = aggregateSchedulerCandidateTimes(candidates);
  const criticalityRank: Record<ScheduledJobDefinition['criticality'], number> = {
    critical: 0,
    normal: 1,
    maintenance: 2,
  };
  return definitions
    .map((definition, index) => ({
      definition,
      index,
      dueAt: candidateTimes.get(definition.name)?.earliestDueAt ?? Number.POSITIVE_INFINITY,
      dispatchDeadline:
        (candidateTimes.get(definition.name)?.earliestScheduledDueAt ?? Number.POSITIVE_INFINITY) +
        (contractForSchedulerJob(definition.name)?.dispatchWithinMs ?? 0),
    }))
    .sort(
      (left, right) =>
        left.dispatchDeadline - right.dispatchDeadline ||
        criticalityRank[left.definition.criticality] -
          criticalityRank[right.definition.criticality] ||
        (left.definition.claimPriority ?? 100) - (right.definition.claimPriority ?? 100) ||
        left.definition.name.localeCompare(right.definition.name) ||
        left.index - right.index,
    )
    .map(({ definition }) => definition);
}

async function claimSchedulerWork(input: {
  definitions: readonly ScheduledJobDefinition[];
  disabledJobNames: readonly string[];
  generationCaps: Readonly<Record<string, number>>;
  now?: Date;
}): Promise<{
  claimed: Awaited<ReturnType<typeof claimSchedulerObligations>>;
  dueCount: number;
  lateCount: number;
  oldestDueAt: Date | null;
}> {
  const disabled = new Set(input.disabledJobNames);
  const candidates = await findDueSchedulerObligationCandidates({
    excludedJobNames: input.disabledJobNames,
  });
  const dueJobNames = new Set(candidates.map((candidate) => candidate.jobName));
  const lanesByJob = new Map(
    input.definitions.map((definition) => [definition.name, schedulerExecutionLanes(definition)]),
  );
  const jobsByLane = new Map<string, Set<string>>();
  for (const [jobName, lanes] of lanesByJob) {
    for (const lane of lanes) {
      const consumers = jobsByLane.get(lane) ?? new Set<string>();
      consumers.add(jobName);
      jobsByLane.set(lane, consumers);
    }
  }

  const claimed: Awaited<ReturnType<typeof claimSchedulerObligations>>[number][] = [];
  for (const definition of orderSchedulerDefinitionsByEarliestDue(input.definitions, candidates)) {
    if (claimed.length >= MAX_SCHEDULER_CLAIMS_PER_PASS) break;
    if (disabled.has(definition.name)) continue;
    if (!dueJobNames.has(definition.name)) continue;
    const lanes = lanesByJob.get(definition.name) ?? [];
    const conflicts = new Set(
      lanes.flatMap((lane) => [...(jobsByLane.get(lane) ?? new Set<string>())]),
    );
    const result = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: [definition.name],
      inFlightConflictJobNames: [...conflicts],
      laneKeys: lanes,
      excludedJobNames: input.disabledJobNames,
      generationCaps: input.generationCaps,
      enforceLatestAuthoritativeScope: POST_MATCH_LATEST_AUTHORITATIVE_JOBS.includes(
        definition.name as (typeof POST_MATCH_LATEST_AUTHORITATIVE_JOBS)[number],
      ),
    });
    if (result[0]) claimed.push(result[0]);
  }
  const dueProgress = schedulerDueProgress(input.definitions, candidates, input.now);
  return {
    claimed,
    dueCount: dueProgress.dueCount,
    lateCount: dueProgress.lateCount,
    oldestDueAt: dueProgress.oldestUnfinishedDueAt,
  };
}

/** Definitions without a feature flag are always enabled. */
export function isSchedulerDefinitionEnabled(
  definition: Pick<ScheduledJobDefinition, 'isEnabled'>,
): boolean {
  return definition.isEnabled?.() ?? true;
}

async function runSchedulerPassUnsafe(now = new Date()): Promise<SchedulerPassResult> {
  // Keep the previous completed-pass milestone while the new pass is running.
  // Replacing it with `null` at pass start makes every ordinary in-flight pass
  // look unhealthy to /jobs/status, even though the scheduler is still making
  // bounded progress.  A genuinely stuck pass is detected when this preserved
  // milestone becomes older than SCHEDULER_PROGRESS_STALE_AFTER_MS.
  const previousProgress = await readSchedulerProgress();
  let progress = {
    ...createSchedulerProgress(now),
    lastCompletedPassAt: previousProgress?.lastCompletedPassAt ?? null,
    lastCompletedDurationMs: previousProgress?.lastCompletedDurationMs ?? null,
    dueCount: previousProgress?.dueCount ?? 0,
    lateCount: previousProgress?.lateCount ?? 0,
    oldestUnfinishedDueAt: previousProgress?.oldestUnfinishedDueAt ?? null,
    generationRecoveryCount: previousProgress?.generationRecoveryCount ?? 0,
    leaseRecoveryCount: previousProgress?.leaseRecoveryCount ?? 0,
  };
  await tryWriteSchedulerProgress(progress);
  progress = advanceSchedulerProgress(progress, 'resolve-context');
  await tryWriteSchedulerProgress(progress);
  const season = await seasonRepository.findCurrent();
  const context = await resolveSchedulerContext(season, now);
  let reserved = 0;
  let failed = 0;
  const latestUnderstatPeriods = new Map<string, { periodKey: string; scopeKey: string }>();
  const latestLegacyPriceChangePeriods = new Map<
    string,
    { periodKey: string; scopeKey: string; dueAt: Date }
  >();
  const latestPostMatchPeriods: Array<{
    jobName: (typeof POST_MATCH_LATEST_AUTHORITATIVE_JOBS)[number];
    periodKey: string;
    scopeKey: string;
    resultSlot: string;
    resultAuthorityAtMs: number;
    resultScheduleAnchorMs: number;
    dueAt: Date;
  }> = [];
  const postMatchReservations: Array<{
    definition: ScheduledJobDefinition;
    plan: SchedulerObligationPlan;
    planKey: string;
  }> = [];
  const singleFlightLanes = new Map<
    string,
    Readonly<{
      definition: ScheduledJobDefinition;
      plan: SchedulerObligationPlan;
      lane: SchedulerLane;
    }>
  >();
  // A lane whose Bull reconciliation was inconclusive must not be reclaimed
  // merely because its short dispatch lease elapsed. Keep this decision
  // separate from the lane snapshot: the database claim below deliberately
  // reloads the row, while this map records whether Redis gave us a positive
  // answer for the generation we observed.
  const singleFlightReconciled = new Map<string, boolean>();
  // Definition planning is pure control-plane work. Resolve independently in
  // a bounded batch so one slow repository/provider-adjacent stage cannot hold
  // the entire 30-second pass hostage, while retaining deterministic result
  // order for coalescing and evidence.
  progress = advanceSchedulerProgress(progress, 'resolve-definitions', undefined, new Date());
  await tryWriteSchedulerProgress(progress);
  const resolutions = await mapWithConcurrency(schedulerRegistry, 4, (definition) =>
    resolveSchedulerDefinition(definition, context),
  );
  for (const [definitionIndex, definition] of schedulerRegistry.entries()) {
    const resolution = resolutions[definitionIndex];
    if (!resolution) {
      failed += 1;
      logError(
        'Scheduler definition resolution returned no result',
        new Error('missing resolution'),
        {
          jobName: definition.name,
        },
      );
      continue;
    }
    if (!resolution.ok) {
      failed += 1;
      logError('Scheduler definition resolution failed', resolution.error, {
        jobName: definition.name,
      });
      continue;
    }
    if (
      UNDERSTAT_LATEST_AUTHORITATIVE_JOBS.includes(
        definition.name as (typeof UNDERSTAT_LATEST_AUTHORITATIVE_JOBS)[number],
      ) &&
      definition.isEnabled?.()
    ) {
      const latestPlan = resolution.plans
        .filter((plan) => plan.terminalStatus === undefined)
        .sort((left, right) => left.periodKey.localeCompare(right.periodKey))
        .at(-1);
      if (latestPlan) {
        latestUnderstatPeriods.set(definition.name, {
          periodKey: latestPlan.periodKey,
          scopeKey: latestPlan.scopeKey,
        });
      }
    }
    if (
      definition.name === 'price-change-predictions' &&
      !definition.executionPolicy &&
      isSchedulerDefinitionEnabled(definition)
    ) {
      const latestPlan = resolution.plans
        .filter((plan) => plan.terminalStatus === undefined)
        .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())
        .at(-1);
      if (latestPlan) {
        latestLegacyPriceChangePeriods.set(definition.name, {
          periodKey: latestPlan.periodKey,
          scopeKey: latestPlan.scopeKey,
          dueAt: latestPlan.dueAt,
        });
      }
    }
    const isPostMatchDefinition = POST_MATCH_LATEST_AUTHORITATIVE_JOBS.includes(
      definition.name as (typeof POST_MATCH_LATEST_AUTHORITATIVE_JOBS)[number],
    );
    if (isPostMatchDefinition) {
      const latestPlans = latestActiveSchedulerPlansByScope(resolution.plans);
      const invalidPlan = resolution.plans.find(
        (plan) =>
          plan.terminalStatus !== undefined ||
          typeof plan.evidence?.resultSlot !== 'string' ||
          plan.evidence.resultSlot.length === 0 ||
          !Number.isSafeInteger(plan.evidence?.resultAuthorityAtMs) ||
          Number(plan.evidence?.resultAuthorityAtMs) <= 0 ||
          !Number.isSafeInteger(plan.evidence?.resultScheduleAnchorMs) ||
          Number(plan.evidence?.resultScheduleAnchorMs) <= 0,
      );
      if (invalidPlan) {
        failed += 1;
        logError(
          'Post-match scheduler plan is missing durable result authority',
          new Error(
            'Post-match resultSlot, resultAuthorityAtMs and resultScheduleAnchorMs evidence are required',
          ),
          {
            jobName: definition.name,
            scopeKey: invalidPlan.scopeKey,
            periodKey: invalidPlan.periodKey,
          },
        );
        continue;
      }
      for (const plan of latestPlans) {
        latestPostMatchPeriods.push({
          jobName: definition.name as (typeof POST_MATCH_LATEST_AUTHORITATIVE_JOBS)[number],
          periodKey: plan.periodKey,
          scopeKey: plan.scopeKey,
          resultSlot: plan.evidence?.resultSlot as string,
          resultAuthorityAtMs: plan.evidence?.resultAuthorityAtMs as number,
          resultScheduleAnchorMs: plan.evidence?.resultScheduleAnchorMs as number,
          dueAt: plan.dueAt,
        });
      }
      for (const plan of resolution.plans) {
        const planKey = schedulerPlanKey(definition, plan);
        // Live finalization remains an active obligation until the league
        // publication proves every required durable checkpoint. Revisit this
        // one plan on every pass so a worker that deferred while evidence was
        // incomplete can be reclaimed as soon as the next retry is due.
        const revisitUntilFinalized = definition.name === 'live-finalization';
        if (!wasPlanObserved(planKey)) {
          postMatchReservations.push({
            definition: { ...definition, queueName: schedulerLaneName(definition) },
            plan,
            planKey,
          });
        } else if (revisitUntilFinalized) {
          postMatchReservations.push({
            definition: { ...definition, queueName: schedulerLaneName(definition) },
            plan,
            planKey,
          });
        }
      }
      continue;
    }
    for (const plan of resolution.plans) {
      const planKey = schedulerPlanKey(definition, plan);
      // My FPL finalization carries the current-event authority in mutable
      // evidence. Revisit its stable identity on every pass so a rollover
      // from current to historical (or vice versa) refreshes eventPriority
      // without creating a second durable obligation.
      const refreshMyFplEventPriority = definition.name === 'my-fpl-finalization';
      // Single-flight lanes must revisit an existing period on every pass so
      // a newly-created desired target can be reconciled after a prior job
      // completed. All other definitions keep the in-process observation
      // guard to avoid redundant reservation reads.
      if (wasPlanObserved(planKey) && !definition.executionPolicy && !refreshMyFplEventPriority)
        continue;
      try {
        let obligation = await reserveSchedulerObligation({
          definition: { ...definition, queueName: schedulerLaneName(definition) },
          plan,
        });
        const eventPriority = plan.evidence?.eventPriority;
        if (
          refreshMyFplEventPriority &&
          typeof eventPriority === 'number' &&
          Number.isSafeInteger(eventPriority) &&
          eventPriority >= 0
        ) {
          obligation = await mergeSchedulerObligationEvidence({
            obligationId: obligation.obligationId,
            evidence: { eventPriority },
          });
        }
        if (!plan.terminalStatus) {
          const freshnessWindowId = await recordFreshnessWindowForPlan(
            definition,
            plan,
            context.season.seasonId,
            obligation,
          );
          if (freshnessWindowId !== null) {
            await attachFreshnessWindowToSchedulerObligation({
              obligationId: obligation.obligationId,
              freshnessWindowId,
            });
          }
        }
        if (plan.terminalStatus) {
          await markSchedulerObligationIrrecoverable({
            obligationId: obligation.obligationId,
            status: plan.terminalStatus,
            evidence: plan.evidence,
            // A current-day-only checkpoint becomes historical at the next
            // pass. Close an enqueued/running prior generation before the
            // reclaim query can create a new worker for that old date.
            includeInFlight:
              definition.catchUpPolicy === 'current-day-only' &&
              plan.terminalStatus === 'irrecoverable',
          });
        }
        rememberObservedPlan(planKey);
        reserved += 1;
        if (definition.executionPolicy && plan.terminalStatus === undefined) {
          const laneKey = definition.executionPolicy.laneKey({ context, plan });
          const advanced = await advanceSchedulerLane({
            laneKey,
            jobName: definition.name,
            scopeKey: plan.scopeKey,
            queueName: definition.queueName,
            desiredObligation: obligation,
          });
          singleFlightLanes.set(laneKey, {
            definition,
            plan,
            lane: advanced.lane,
          });
        }
      } catch (error) {
        failed += 1;
        logError('Scheduler plan reservation failed', error, {
          jobName: definition.name,
          scopeKey: plan.scopeKey,
          periodKey: plan.periodKey,
        });
      }
    }
  }

  progress = advanceSchedulerProgress(progress, 'reserve-obligations', undefined, new Date());
  await tryWriteSchedulerProgress(progress);

  try {
    const result = await reconcilePostMatchSchedulerObligations({
      reservations: postMatchReservations.map(({ definition, plan }) => ({ definition, plan })),
      boundaries: latestPostMatchPeriods.map((latest) => ({
        jobName: latest.jobName,
        scopeKey: latest.scopeKey,
        periodKey: latest.periodKey,
        resultSlot: latest.resultSlot,
        resultAuthorityAtMs: latest.resultAuthorityAtMs,
        resultScheduleAnchorMs: latest.resultScheduleAnchorMs,
        beforeDueAt: latest.dueAt,
      })),
      evidence: { checkpoint: 'post-match-results' },
    });
    for (const [index, { plan, planKey }] of postMatchReservations.entries()) {
      if (postMatchReservationWasPersisted(plan, result.reservations[index])) {
        rememberObservedPlan(planKey);
        const freshnessWindowId = await recordFreshnessWindowForPlan(
          postMatchReservations[index].definition,
          plan,
          context.season.seasonId,
          result.reservations[index],
        );
        if (freshnessWindowId !== null) {
          const obligation = result.reservations[index];
          if (obligation) {
            await attachFreshnessWindowToSchedulerObligation({
              obligationId: obligation.obligationId,
              freshnessWindowId,
            });
          }
        }
      }
    }
    reserved += result.reservations.length;
  } catch (error) {
    failed += 1;
    logError('Post-match atomic reservation and coalescing failed', error, {
      reservationCount: postMatchReservations.length,
      boundaryCount: latestPostMatchPeriods.length,
    });
  }

  progress = advanceSchedulerProgress(progress, 'coalesce-latest-authority', undefined, new Date());
  await tryWriteSchedulerProgress(progress);

  for (const [jobName, latest] of latestUnderstatPeriods) {
    try {
      await supersedeSchedulerObligations({
        jobName,
        beforePeriodKey: latest.periodKey,
        evidence: { supersededByPeriodKey: latest.periodKey },
      });
      if (
        await hasEarlierInFlightSchedulerObligation({
          jobName,
          beforePeriodKey: latest.periodKey,
        })
      ) {
        await deferSchedulerObligationByIdentity({
          jobName,
          scopeKey: latest.scopeKey,
          periodKey: latest.periodKey,
          delayMs: UNDERSTAT_IN_FLIGHT_DEFER_MS,
          error: 'Waiting for an earlier Understat daily obligation to drain',
        });
      }
    } catch (error) {
      failed += 1;
      logError('Understat stale obligation coalescing failed', error, {
        jobName,
        periodKey: latest.periodKey,
      });
    }
  }

  for (const [jobName, latest] of latestLegacyPriceChangePeriods) {
    try {
      await supersedeSchedulerObligationsByDueAt({
        jobName,
        scopeKey: latest.scopeKey,
        beforeDueAt: latest.dueAt,
        evidence: {
          dataset: 'fpl:price-changes',
          supersededByPeriodKey: latest.periodKey,
        },
      });
    } catch (error) {
      failed += 1;
      logError('Legacy price-change stale obligation coalescing failed', error, {
        jobName,
        scopeKey: latest.scopeKey,
        periodKey: latest.periodKey,
      });
    }
  }

  const featureDisabledJobNames = schedulerRegistry
    .filter((definition) => definition.isEnabled && !definition.isEnabled())
    .map((definition) => definition.name);
  let enqueueRecovery: SchedulerEnqueueRecoveryResult | null = null;
  try {
    const latestWinsJobNames = schedulerRegistry
      .filter((definition) => definition.executionPolicy)
      .map((definition) => definition.name);
    enqueueRecovery = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: schedulerRegistry,
      // A disabled provider must not be resurrected by lease recovery while
      // its rollout flag is off. Existing in-flight jobs can still drain, but
      // an expired claim waits for an explicit re-enable/reconcile pass.
      excludedJobNames: [...latestWinsJobNames, ...featureDisabledJobNames],
    });
    failed += enqueueRecovery.errors;
  } catch (error) {
    failed += 1;
    logError('Scheduler expired enqueue claim reconciliation failed', error);
  }

  const disabledJobNames = [
    ...featureDisabledJobNames,
    ...(await admissionDisabledSchedulerJobs(schedulerRegistry)),
  ];
  // The lane is the only authority for latest-wins jobs. Keeping these
  // obligations out of the generic claim query prevents an elapsed
  // scheduler lease from creating a second generation while Bull still owns
  // the original waiting/active job.
  for (const definition of schedulerRegistry) {
    if (definition.executionPolicy && !disabledJobNames.includes(definition.name)) {
      disabledJobNames.push(definition.name);
    }
  }
  const generationCaps = Object.fromEntries(
    UNDERSTAT_SCHEDULER_JOB_NAMES.map((jobName) => [jobName, UNDERSTAT_SCHEDULER_GENERATION_CAP]),
  );
  const claimResult = await claimSchedulerWork({
    definitions: schedulerRegistry,
    disabledJobNames,
    generationCaps,
    now,
  });
  const claimed = claimResult.claimed;
  progress = advanceSchedulerProgress(
    progress,
    'enqueue-claimed-obligations',
    { claimedCount: claimed.length },
    new Date(),
  );
  await tryWriteSchedulerProgress(progress);
  let enqueued = 0;
  let laneClaimed = 0;
  await Promise.all(
    [...singleFlightLanes.values()].map(async (entry) => {
      try {
        await reconcileSingleFlightBullState(entry.lane, season);
        singleFlightReconciled.set(entry.lane.laneId, true);
      } catch (error) {
        // Do not let an inconclusive Redis read fall through to
        // claimSchedulerLaneDispatch: an expired dispatching lease may still
        // represent a job accepted by Bull whose response was lost.
        singleFlightReconciled.set(entry.lane.laneId, false);
        failed += 1;
        logError('Latest-wins Bull state reconciliation failed', error, {
          laneId: entry.lane.laneId,
          laneKey: entry.lane.laneKey,
        });
        return;
      }
      try {
        await alertPriceLaneFreshness(entry.lane, season);
      } catch (error) {
        failed += 1;
        logError('Latest-wins price freshness alert failed', error, {
          laneId: entry.lane.laneId,
          laneKey: entry.lane.laneKey,
        });
      }
    }),
  );
  for (const [laneKey, entry] of singleFlightLanes) {
    if (singleFlightReconciled.get(entry.lane.laneId) !== true) continue;
    const dispatch = await claimSchedulerLaneDispatch({ laneId: entry.lane.laneId });
    if (!dispatch) continue;
    laneClaimed += 1;
    try {
      const target = await getSchedulerLaneTarget({ laneId: dispatch.lane.laneId });
      if (!target) throw new Error(`Scheduler lane target disappeared: ${laneKey}`);
      const result = await entry.definition.enqueue({
        context,
        plan: {
          scopeKey: target.obligation.scopeKey,
          periodKey: target.obligation.periodKey,
          dueAt: target.obligation.dueAt,
          source: target.obligation.source,
          ...(typeof target.obligation.evidence.targetEventId === 'number'
            ? { eventId: target.obligation.evidence.targetEventId }
            : {}),
          evidence: target.obligation.evidence,
        },
        obligationId: target.obligation.obligationId,
        generation: target.obligation.generation,
        freshnessWindowId: freshnessWindowIdFromEvidence(target.obligation.evidence),
        freshnessWindowIds: freshnessWindowIdsFromEvidence(target.obligation.evidence),
        laneId: dispatch.lane.laneId,
        dispatchGeneration: dispatch.lane.dispatchGeneration,
      });
      const bullJobId = result?.bullJobId;
      if (bullJobId === undefined) throw new Error('Latest-wins enqueue returned no Bull job ID');
      const confirmed = await confirmSchedulerLaneEnqueued({
        laneId: dispatch.lane.laneId,
        owner: dispatch.owner,
        bullJobId,
        runId: result?.runId,
        obligationId: target.obligation.obligationId,
        queueName: dispatch.lane.queueName,
      });
      if (!confirmed) throw new Error('Scheduler lane enqueue confirmation CAS failed');
      enqueued += 1;
    } catch (error) {
      if (error instanceof QueueDrainOnlyError) {
        await failSchedulerLaneDispatch({
          laneId: dispatch.lane.laneId,
          owner: dispatch.owner,
          error: 'QUEUE_DRAIN_ONLY',
        });
        logInfo('Latest-wins scheduler lane deferred by admission gate', {
          laneKey,
          laneId: dispatch.lane.laneId,
        });
        continue;
      }
      let reconciliationConfirmed = true;
      try {
        await reconcileSingleFlightBullState(dispatch.lane);
      } catch (reconcileError) {
        reconciliationConfirmed = false;
        logError('Latest-wins enqueue ambiguity reconciliation failed', reconcileError, {
          laneId: dispatch.lane.laneId,
          dispatchGeneration: dispatch.lane.dispatchGeneration,
        });
      }
      const current = await getSchedulerLane({ laneId: dispatch.lane.laneId });
      if (current?.state === 'enqueued' || current?.state === 'running') {
        enqueued += 1;
        continue;
      }
      // A failed enqueue response is ambiguous until Bull positively reports
      // the expected deterministic job as missing/failed.  If Redis is
      // unavailable (or the state is otherwise inconclusive), retain the
      // dispatch lease and let the next scheduler pass reconcile it. Releasing
      // the lane here could create a second generation while the first Bull
      // job is still runnable.
      if (!reconciliationConfirmed || current?.state === 'dispatching') {
        failed += 1;
        logError('Latest-wins enqueue failure deferred pending Bull reconciliation', error, {
          laneKey,
          laneId: dispatch.lane.laneId,
          dispatchGeneration: dispatch.lane.dispatchGeneration,
          reconciliationConfirmed,
        });
        continue;
      }
      failed += 1;
      await failSchedulerLaneDispatch({
        laneId: dispatch.lane.laneId,
        owner: dispatch.owner,
        error,
      });
      logError('Scheduler latest-wins lane enqueue failed', error, {
        laneKey,
        laneId: dispatch.lane.laneId,
        dispatchGeneration: dispatch.lane.dispatchGeneration,
      });
    }
  }
  await Promise.all(
    claimed.map(async ({ obligation, owner }) => {
      const definition = definitionByName(obligation.jobName);
      if (!definition) {
        failed += 1;
        await failSchedulerObligation({
          obligationId: obligation.obligationId,
          owner,
          error: `Unknown scheduled job definition: ${obligation.jobName}`,
        });
        return;
      }
      try {
        const result = await definition.enqueue({
          context,
          plan: {
            scopeKey: obligation.scopeKey,
            periodKey: obligation.periodKey,
            dueAt: obligation.dueAt,
            source: obligation.source,
            ...(typeof obligation.evidence.targetEventId === 'number'
              ? { eventId: obligation.evidence.targetEventId }
              : {}),
            evidence: obligation.evidence,
          },
          obligationId: obligation.obligationId,
          generation: obligation.generation,
          freshnessWindowId: freshnessWindowIdFromEvidence(obligation.evidence),
          freshnessWindowIds: freshnessWindowIdsFromEvidence(obligation.evidence),
        });
        const confirmed = await confirmSchedulerObligationEnqueued({
          obligationId: obligation.obligationId,
          owner,
          bullJobId: result?.bullJobId,
          runId: result?.runId,
          queueName: schedulerLaneName(definition),
        });
        if (!confirmed) {
          throw new Error('Scheduler enqueue confirmation lost its obligation lease');
        }
        // Enqueue confirmation is not success evidence.  A queue worker or a
        // checkpoint reconciler must transition this row to succeeded.
        enqueued += 1;
      } catch (error) {
        if (error instanceof QueueDrainOnlyError) {
          await deferSchedulerObligationForAdmission({
            obligationId: obligation.obligationId,
            owner,
            generation: obligation.generation,
            delayMs: error.retryAfterSeconds * 1_000,
          });
          logInfo('Scheduler obligation deferred by admission gate', {
            jobName: obligation.jobName,
            obligationId: obligation.obligationId,
          });
          return;
        }
        failed += 1;
        await failSchedulerObligation({ obligationId: obligation.obligationId, owner, error });
        logError('Scheduler obligation enqueue failed', error, {
          jobName: obligation.jobName,
          obligationId: obligation.obligationId,
          generation: obligation.generation,
        });
      }
    }),
  );
  logInfo('Scheduler reconciliation pass completed', {
    definitions: schedulerRegistry.length,
    reserved,
    claimed: claimed.length + laneClaimed,
    enqueued,
    failed,
    enqueueRecovery,
  });
  // The claim query is intentionally evaluated before enqueueing so it can
  // order this pass.  Refresh it after all enqueue callbacks have settled so
  // /jobs/status does not keep reporting a just-claimed bucket as due after
  // its worker has already completed (or after the obligation was deferred).
  let completedDueProgress = schedulerDueProgress(schedulerRegistry, [], new Date());
  try {
    const remainingDueCandidates = await findDueSchedulerObligationCandidates({
      // Keep the post-pass view aligned with the claim view. Latest-wins lane
      // jobs and admission-disabled definitions are reconciled by their own
      // owner, so they must not reappear as generic scheduler due work.
      excludedJobNames: disabledJobNames,
    });
    completedDueProgress = schedulerDueProgress(
      schedulerRegistry,
      remainingDueCandidates,
      new Date(),
    );
  } catch (error) {
    // A telemetry refresh failure must not turn a successfully reconciled pass
    // into a failed pass.  Keep the pass-start values as a conservative
    // fallback; the next 30-second pass will retry the authoritative query.
    logError('Scheduler post-pass due-state refresh failed', error);
    completedDueProgress = {
      dueCount: claimResult.dueCount,
      lateCount: claimResult.lateCount,
      oldestUnfinishedDueAt: claimResult.oldestDueAt,
    };
  }
  progress = completeSchedulerProgress(progress, new Date());
  progress = {
    ...progress,
    dueCount: completedDueProgress.dueCount,
    lateCount: completedDueProgress.lateCount,
    oldestUnfinishedDueAt: completedDueProgress.oldestUnfinishedDueAt?.toISOString() ?? null,
    leaseRecoveryCount: (enqueueRecovery?.running ?? 0) + (enqueueRecovery?.retained ?? 0),
    generationRecoveryCount: enqueueRecovery?.retried ?? 0,
  };
  await tryWriteSchedulerProgress(progress);
  return {
    definitions: schedulerRegistry.length,
    reserved,
    claimed: claimed.length + laneClaimed,
    enqueued,
    failed,
  };
}

/**
 * Persist a bounded error marker when a pass fails before it can complete its
 * normal progress write. Heartbeat remains independent process liveness; this
 * marker is what lets jobs/status distinguish a stuck pass from a healthy one.
 */
export async function runSchedulerPass(now = new Date()): Promise<SchedulerPassResult> {
  try {
    return await runSchedulerPassUnsafe(now);
  } catch (error) {
    try {
      const progress = await readSchedulerProgress();
      if (progress) {
        await writeSchedulerProgress({
          ...progress,
          currentStage: 'failed',
          stageStartedAt: new Date().toISOString(),
          lastPassErrorCode: safeDataErrorCode(error),
        });
      }
    } catch (progressError) {
      logError('Scheduler failure progress persistence failed', progressError);
    }
    throw error;
  }
}

/**
 * API cron/timer compatibility bridge.  A rolling deployment can leave the
 * API process ticking while the dedicated scheduler is being introduced; all
 * of those ticks must still reserve and enqueue through the same obligation
 * catalog rather than bypassing it with direct BullMQ calls.
 */
export async function runCompatibilitySchedulerPass(now = new Date()): Promise<void> {
  if (compatibilityPassInFlight) return compatibilityPassInFlight;
  const pass = runSchedulerPass(now)
    .then(() => undefined)
    .finally(() => {
      compatibilityPassInFlight = null;
    });
  compatibilityPassInFlight = pass;
  await pass;
}
