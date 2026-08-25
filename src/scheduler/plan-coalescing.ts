import type { SchedulerObligationPlan } from './job-registry';

/**
 * Keep only the newest non-terminal checkpoint for each durable scope. The
 * caller can then retire older pending/failed obligations without touching
 * work that is already enqueued or running.
 */
export function latestActiveSchedulerPlansByScope(
  plans: readonly SchedulerObligationPlan[],
): readonly SchedulerObligationPlan[] {
  const latest = new Map<string, SchedulerObligationPlan>();
  for (const plan of plans) {
    if (plan.terminalStatus) continue;
    const current = latest.get(plan.scopeKey);
    if (!current || plan.dueAt.getTime() > current.dueAt.getTime()) {
      latest.set(plan.scopeKey, plan);
    }
  }
  return [...latest.values()].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
}
