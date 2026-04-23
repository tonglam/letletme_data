import { AsyncLocalStorage } from 'async_hooks';

export interface JobLogContext {
  jobType: 'cron' | 'queue';
  jobName: string;
  queueName?: string;
  jobId?: string | number;
  eventId?: number;
  tournamentId?: number;
  source?: string;
  attempt?: number;
}

const jobLogContextStore = new AsyncLocalStorage<JobLogContext>();

export function getJobLogContext(): JobLogContext | undefined {
  return jobLogContextStore.getStore();
}

export async function runWithJobLogContext<T>(
  context: JobLogContext,
  runner: () => Promise<T>,
): Promise<T> {
  return jobLogContextStore.run(context, runner);
}
