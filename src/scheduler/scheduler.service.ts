import { randomUUID } from 'node:crypto';
import { seasonRepository } from '../repositories/seasons';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { Queue } from 'bullmq';

import {
  claimSchedulerObligations,
  confirmSchedulerObligationEnqueued,
  deferSchedulerObligationByIdentity,
  failSchedulerObligation,
  findDueSchedulerJobNames,
  hasEarlierInFlightSchedulerObligation,
  markSchedulerObligationIrrecoverable,
  reconcilePostMatchSchedulerObligations,
  reserveSchedulerObligation,
  supersedeSchedulerObligations,
  supersedeSchedulerObligationsByDueAt,
  type SchedulerObligation,
} from '../repositories/scheduler-obligations';
import {
  advanceSchedulerLane,
  claimSchedulerLaneDispatch,
  confirmSchedulerLaneEnqueued,
  failSchedulerLaneDispatch,
  getSchedulerLane,
  getSchedulerLaneTarget,
  recoverSchedulerLaneAfterBullLoss,
  type SchedulerLane,
} from '../repositories/scheduler-lanes';
import {
  resolveSchedulerContext,
  schedulerRegistry,
  type ScheduledJobDefinition,
  type SchedulerContext,
  type SchedulerObligationPlan,
} from './job-registry';
import { latestActiveSchedulerPlansByScope } from './plan-coalescing';
import { logError, logInfo } from '../utils/logger';
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
): Promise<
  | Readonly<{ ok: true; plans: readonly SchedulerObligationPlan[] }>
  | Readonly<{ ok: false; error: unknown }>
> {
  try {
    return { ok: true, plans: await definition.resolve(context) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Manual price-change requests join the same latest-wins lane as the
 * scheduler. A caller receives the existing Bull ID when work is already
 * waiting/running/blocked; it never creates a parallel direct data-sync job.
 */
export async function triggerPriceChangeLane(): Promise<{
  bullJobId?: string | number;
  runId?: string;
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
  let plan: SchedulerObligationPlan = { ...basePlan, source: 'manual' };
  let obligation = await reserveSchedulerObligation({
    definition,
    plan,
  });
  // The cadence identity is intentionally immutable once it has succeeded.
  // A later manual refresh must therefore get a new dispatchable obligation;
  // reusing the terminal five-minute row would make advanceSchedulerLane
  // correctly (but undesirably) report no work.
  if (['succeeded', 'skipped', 'irrecoverable'].includes(obligation.status)) {
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
  const laneKey = definition.executionPolicy.laneKey({ context, plan });
  const advanced = await advanceSchedulerLane({
    laneKey,
    jobName: definition.name,
    scopeKey: plan.scopeKey,
    queueName: definition.queueName,
    desiredObligation: obligation,
  });
  if (!advanced.shouldDispatch) {
    return {
      ...(advanced.lane.bullJobId
        ? { bullJobId: advanced.lane.bullJobId }
        : advanced.lane.blockerJobId
          ? { bullJobId: advanced.lane.blockerJobId }
          : {}),
      ...(advanced.lane.runId ? { runId: advanced.lane.runId } : {}),
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
    });
    if (result?.bullJobId === undefined)
      throw new Error('Manual price enqueue returned no Bull ID');
    const confirmed = await confirmSchedulerLaneEnqueued({
      laneId: dispatch.lane.laneId,
      owner: dispatch.owner,
      bullJobId: result.bullJobId,
      runId: result.runId,
      obligationId: target.obligation.obligationId,
    });
    if (!confirmed) throw new Error('Manual price lane enqueue confirmation CAS failed');
    return result;
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

async function reconcileSingleFlightBullState(lane: SchedulerLane): Promise<void> {
  if (lane.state === 'dispatching' && lane.dispatchOwner) {
    const queue = new Queue(lane.queueName, { connection: getQueueConnection() });
    try {
      // Price lane enqueue IDs are deterministic. Recover a successful Redis
      // add even when the scheduler lost the response before its CAS write;
      // otherwise the two-minute dispatch lease would create a duplicate.
      const expectedJobId = `scheduler-lane-${lane.laneId}-g${lane.dispatchGeneration}`;
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
        });
        if (!confirmed) {
          logError('Latest-wins dispatch recovery CAS failed', undefined, {
            laneId: lane.laneId,
            dispatchGeneration: lane.dispatchGeneration,
            bullJobId: job.id,
          });
        }
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

export function schedulerExecutionLanes(
  definition: Pick<ScheduledJobDefinition, 'executionLanes' | 'queueName'>,
): readonly string[] {
  const configured = [...new Set(definition.executionLanes ?? [])].filter(
    (lane) => lane.trim().length > 0,
  );
  return configured.length > 0 ? configured.sort() : [`queue:${definition.queueName}`];
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

async function claimSchedulerWork(input: {
  definitions: readonly ScheduledJobDefinition[];
  disabledJobNames: readonly string[];
  generationCaps: Readonly<Record<string, number>>;
}): Promise<Awaited<ReturnType<typeof claimSchedulerObligations>>> {
  const disabled = new Set(input.disabledJobNames);
  const dueJobNames = new Set(
    await findDueSchedulerJobNames({ excludedJobNames: input.disabledJobNames }),
  );
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
  for (const definition of orderSchedulerDefinitionsForClaim(input.definitions)) {
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
  return claimed;
}

/** Definitions without a feature flag are always enabled. */
export function isSchedulerDefinitionEnabled(
  definition: Pick<ScheduledJobDefinition, 'isEnabled'>,
): boolean {
  return definition.isEnabled?.() ?? true;
}

export async function runSchedulerPass(now = new Date()): Promise<SchedulerPassResult> {
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
  for (const definition of schedulerRegistry) {
    const resolution = await resolveSchedulerDefinition(definition, context);
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
        if (!wasPlanObserved(planKey)) {
          postMatchReservations.push({ definition, plan, planKey });
        }
      }
      continue;
    }
    for (const plan of resolution.plans) {
      const planKey = schedulerPlanKey(definition, plan);
      // Single-flight lanes must revisit an existing period on every pass so
      // a newly-created desired target can be reconciled after a prior job
      // completed. All other definitions keep the in-process observation
      // guard to avoid redundant reservation reads.
      if (wasPlanObserved(planKey) && !definition.executionPolicy) continue;
      try {
        const obligation = await reserveSchedulerObligation({ definition, plan });
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

  let enqueueRecovery: SchedulerEnqueueRecoveryResult | null = null;
  try {
    const latestWinsJobNames = schedulerRegistry
      .filter((definition) => definition.executionPolicy)
      .map((definition) => definition.name);
    enqueueRecovery = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: schedulerRegistry,
      excludedJobNames: latestWinsJobNames,
    });
    failed += enqueueRecovery.errors;
  } catch (error) {
    failed += 1;
    logError('Scheduler expired enqueue claim reconciliation failed', error);
  }

  const disabledJobNames = schedulerRegistry
    .filter((definition) => definition.isEnabled && !definition.isEnabled())
    .map((definition) => definition.name);
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
  const claimed = await claimSchedulerWork({
    definitions: schedulerRegistry,
    disabledJobNames,
    generationCaps,
  });
  let enqueued = 0;
  let laneClaimed = 0;
  await Promise.all(
    [...singleFlightLanes.values()].map((entry) =>
      Promise.all([
        reconcileSingleFlightBullState(entry.lane),
        alertPriceLaneFreshness(entry.lane, season),
      ]).catch((error) => {
        failed += 1;
        logError('Latest-wins Bull state reconciliation failed', error, {
          laneId: entry.lane.laneId,
          laneKey: entry.lane.laneKey,
        });
      }),
    ),
  );
  for (const [laneKey, entry] of singleFlightLanes) {
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
      });
      if (!confirmed) throw new Error('Scheduler lane enqueue confirmation CAS failed');
      enqueued += 1;
    } catch (error) {
      await reconcileSingleFlightBullState(dispatch.lane).catch((reconcileError) => {
        logError('Latest-wins enqueue ambiguity reconciliation failed', reconcileError, {
          laneId: dispatch.lane.laneId,
          dispatchGeneration: dispatch.lane.dispatchGeneration,
        });
      });
      const current = await getSchedulerLane({ laneId: dispatch.lane.laneId });
      if (current?.state === 'enqueued' || current?.state === 'running') {
        enqueued += 1;
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
        });
        const confirmed = await confirmSchedulerObligationEnqueued({
          obligationId: obligation.obligationId,
          owner,
          bullJobId: result?.bullJobId,
          runId: result?.runId,
        });
        if (!confirmed) {
          throw new Error('Scheduler enqueue confirmation lost its obligation lease');
        }
        // Enqueue confirmation is not success evidence.  A queue worker or a
        // checkpoint reconciler must transition this row to succeeded.
        enqueued += 1;
      } catch (error) {
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
  return {
    definitions: schedulerRegistry.length,
    reserved,
    claimed: claimed.length + laneClaimed,
    enqueued,
    failed,
  };
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
