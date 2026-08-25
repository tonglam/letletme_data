import { inspectSchedulerObligationFence } from './scheduler-obligation-fence';

export function understatFailureBookkeepingPlan(data: {
  obligationId?: string;
  obligationGeneration?: number;
}): Readonly<{ recordDomainFailure: true; settleScheduler: boolean }> {
  return {
    // A malformed scheduler fence must never suppress the provider run/item
    // terminal state. Only the generation-unsafe scheduler mutation is gated.
    recordDomainFailure: true,
    settleScheduler: inspectSchedulerObligationFence(data).kind !== 'malformed',
  };
}
