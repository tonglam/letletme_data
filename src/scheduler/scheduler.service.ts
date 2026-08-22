import { seasonRepository } from '../repositories/seasons';
import {
  claimSchedulerObligations,
  confirmSchedulerObligationEnqueued,
  failSchedulerObligation,
  markSchedulerObligationIrrecoverable,
  reserveSchedulerObligation,
} from '../repositories/scheduler-obligations';
import {
  resolveSchedulerContext,
  schedulerRegistry,
  type ScheduledJobDefinition,
} from './job-registry';
import { logError, logInfo } from '../utils/logger';

export type SchedulerPassResult = Readonly<{
  definitions: number;
  reserved: number;
  claimed: number;
  enqueued: number;
  failed: number;
}>;

let compatibilityPassInFlight: Promise<void> | null = null;

function definitionByName(name: string): ScheduledJobDefinition | undefined {
  return schedulerRegistry.find((definition) => definition.name === name);
}

export async function runSchedulerPass(now = new Date()): Promise<SchedulerPassResult> {
  const season = await seasonRepository.findCurrent();
  const context = await resolveSchedulerContext(season, now);
  let reserved = 0;
  for (const definition of schedulerRegistry) {
    const plans = await definition.resolve(context);
    for (const plan of plans) {
      const obligation = await reserveSchedulerObligation({ definition, plan });
      if (plan.terminalStatus) {
        await markSchedulerObligationIrrecoverable({
          obligationId: obligation.obligationId,
          status: plan.terminalStatus,
          evidence: plan.evidence,
        });
      }
      reserved += 1;
    }
  }

  const claimed = await claimSchedulerObligations();
  let enqueued = 0;
  let failed = 0;
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
