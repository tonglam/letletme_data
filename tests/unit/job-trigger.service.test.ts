import { describe, expect, test } from 'bun:test';

import {
  JobNotFoundError,
  listTriggerableJobs,
  triggerJob,
} from '../../src/services/job-trigger.service';
import { ValidationError } from '../../src/utils/errors';

describe('job-trigger service', () => {
  test('lists known triggerable jobs', () => {
    const jobs = listTriggerableJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some((job) => job.name === 'events-sync')).toBe(true);
    expect(jobs.some((job) => job.name === 'player-prices')).toBe(true);
    expect(jobs.every((job) => job.name && job.description && job.schedule)).toBe(true);
  });

  test('throws JobNotFoundError for unknown job', async () => {
    await expect(triggerJob('not-a-real-job')).rejects.toThrow(JobNotFoundError);
  });

  test('JobNotFoundError carries the job name', () => {
    const error = new JobNotFoundError('foo');
    expect(error.message).toContain('foo');
    expect(error.name).toBe('JobNotFoundError');
  });

  test('player-prices requires an explicit YYYYMMDD payload', async () => {
    await expect(triggerJob('player-prices')).rejects.toBeInstanceOf(ValidationError);
    await expect(triggerJob('player-prices', { changeDate: '2026-08-02' })).rejects.toThrow(
      'requires a changeDate in YYYYMMDD format',
    );
  });
});
