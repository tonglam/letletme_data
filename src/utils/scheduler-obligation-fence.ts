import { startSchedulerObligation } from '../repositories/scheduler-obligations';
import { logError, logInfo } from './logger';

type SchedulerObligationJobData = Readonly<{
  obligationId?: string;
  obligationGeneration?: number;
}>;

type SchedulerObligationJobContext = Readonly<{
  queueName: string;
  jobName: string;
  jobId?: string | number;
}>;

/**
 * Manual jobs do not carry an obligation fence. Scheduled jobs must carry
 * both fields, and may run only while their exact generation is authoritative.
 */
export async function startCurrentSchedulerJob(
  data: SchedulerObligationJobData,
  context: SchedulerObligationJobContext,
): Promise<boolean> {
  const hasObligationId = typeof data.obligationId === 'string' && data.obligationId.length > 0;
  const hasGeneration = data.obligationGeneration !== undefined;
  if (!hasObligationId && !hasGeneration) return true;

  if (!hasObligationId || !hasGeneration) {
    logError(
      'Skipping scheduled job with an incomplete generation fence',
      new Error('Scheduled job must carry both obligationId and obligationGeneration'),
      {
        ...context,
        obligationId: data.obligationId,
        obligationGeneration: data.obligationGeneration,
      },
    );
    return false;
  }

  const started = await startSchedulerObligation({
    obligationId: data.obligationId!,
    generation: data.obligationGeneration!,
  });
  if (!started) {
    logInfo('Skipping stale scheduler generation before job execution', {
      ...context,
      obligationId: data.obligationId,
      obligationGeneration: data.obligationGeneration,
    });
  }
  return started;
}
