import { seasonRepository } from '../repositories/seasons';
import {
  claimSchedulerObligations,
  confirmSchedulerObligationEnqueued,
  deferSchedulerObligationByIdentity,
  failSchedulerObligation,
  hasEarlierInFlightSchedulerObligation,
  markSchedulerObligationIrrecoverable,
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
import { logError, logInfo } from '../utils/logger';

// Definitions intentionally resolve the same durable checkpoint on every
// 30-second pass. Once this process has successfully reserved a plan, repeated
// INSERT ON CONFLICT reads add no recovery value because claiming below remains
// database-driven. The terminal status is part of the key: a current-day plan
// observed as active must still be revisited as irrecoverable after its window.
const MAX_OBSERVED_PLAN_KEYS = 20_000;
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
const observedPlanKeys = new Map<string, true>();

export function schedulerPlanKey(
  definition: Pick<ScheduledJobDefinition, 'name'>,
  plan: Pick<SchedulerObligationPlan, 'scopeKey' | 'periodKey' | 'terminalStatus'>,
): string {
  return JSON.stringify([
    definition.name,
    plan.scopeKey,
    plan.periodKey,
    plan.terminalStatus ?? 'active',
  ]);
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
    if (definition.name === 'price-change-predictions' && definition.isEnabled?.()) {
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

  const disabledJobNames = schedulerRegistry
    .filter((definition) => definition.isEnabled && !definition.isEnabled())
    .map((definition) => definition.name);
  const generationCaps = Object.fromEntries(
    UNDERSTAT_SCHEDULER_JOB_NAMES.map((jobName) => [jobName, UNDERSTAT_SCHEDULER_GENERATION_CAP]),
  );
  const claimed = await claimSchedulerObligations({
    excludedJobNames: disabledJobNames,
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
