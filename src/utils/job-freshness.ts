import type { Job } from 'bullmq';

import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';

type FreshnessJobData = {
  freshAfter?: string;
};

export async function resolveJobFreshAfter<T extends FreshnessJobData>(
  job: Pick<Job<T>, 'data' | 'updateData'>,
  readOrderingTimestamp = readDatabaseOrderingTimestamp,
): Promise<string> {
  if (job.data.freshAfter) {
    return job.data.freshAfter;
  }

  const freshAfter = (await readOrderingTimestamp()).exact;
  const updatedData = { ...job.data, freshAfter };
  await job.updateData(updatedData);
  job.data = updatedData;
  return freshAfter;
}
