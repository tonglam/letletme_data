import { seasonRepository } from '../repositories/seasons';
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
} from '../repositories/scheduler-obligations';
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
  if (
    typeof resultSlot === 'string' &&
    /^(provisional|final)-\d+$/.test(resultSlot) &&
    Number.isSafeInteger(resultAuthorityAtMs) &&
    Number(resultAuthorityAtMs) > 0
  ) {
    identity.push(Number(resultAuthorityAtMs));
  }
  return JSON.stringify(identity);
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

let compatibilityPassInFlight: Promise<void> | null = null;

function definitionByName(name: string): ScheduledJobDefinition | undefined {
  return schedulerRegistry.find((definition) => definition.name === name);
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
  const latestPriceChangePeriods = new Map<
    string,
    { periodKey: string; scopeKey: string; dueAt: Date }
  >();
  const latestPostMatchPeriods: Array<{
    jobName: (typeof POST_MATCH_LATEST_AUTHORITATIVE_JOBS)[number];
    periodKey: string;
    scopeKey: string;
    resultSlot: string;
    resultAuthorityAtMs: number;
    dueAt: Date;
  }> = [];
  const postMatchReservations: Array<{
    definition: ScheduledJobDefinition;
    plan: SchedulerObligationPlan;
    planKey: string;
  }> = [];
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
      isSchedulerDefinitionEnabled(definition)
    ) {
      const latestPlan = resolution.plans
        .filter((plan) => plan.terminalStatus === undefined)
        .sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime())
        .at(-1);
      if (latestPlan) {
        latestPriceChangePeriods.set(definition.name, {
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
          Number(plan.evidence?.resultAuthorityAtMs) <= 0,
      );
      if (invalidPlan) {
        failed += 1;
        logError(
          'Post-match scheduler plan is missing durable result authority',
          new Error('Post-match resultSlot and resultAuthorityAtMs evidence are required'),
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
      if (wasPlanObserved(planKey)) continue;
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
        beforeDueAt: latest.dueAt,
      })),
      evidence: { checkpoint: 'post-match-results' },
    });
    for (const { planKey } of postMatchReservations) rememberObservedPlan(planKey);
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

  for (const [jobName, latest] of latestPriceChangePeriods) {
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
      logError('Price-change stale obligation coalescing failed', error, {
        jobName,
        scopeKey: latest.scopeKey,
        periodKey: latest.periodKey,
      });
    }
  }

  let enqueueRecovery: SchedulerEnqueueRecoveryResult | null = null;
  try {
    enqueueRecovery = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: schedulerRegistry,
    });
    failed += enqueueRecovery.errors;
  } catch (error) {
    failed += 1;
    logError('Scheduler expired enqueue claim reconciliation failed', error);
  }

  const disabledJobNames = schedulerRegistry
    .filter((definition) => definition.isEnabled && !definition.isEnabled())
    .map((definition) => definition.name);
  const generationCaps = Object.fromEntries(
    UNDERSTAT_SCHEDULER_JOB_NAMES.map((jobName) => [jobName, UNDERSTAT_SCHEDULER_GENERATION_CAP]),
  );
  const claimed = await claimSchedulerWork({
    definitions: schedulerRegistry,
    disabledJobNames,
    generationCaps,
  });
  let enqueued = 0;
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
    claimed: claimed.length,
    enqueued,
    failed,
    enqueueRecovery,
  });
  return {
    definitions: schedulerRegistry.length,
    reserved,
    claimed: claimed.length,
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
