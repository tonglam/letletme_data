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
    expect(jobs.some((job) => job.name === 'core-snapshot-sync')).toBe(true);
    expect(jobs.some((job) => job.name === 'player-prices')).toBe(true);
    expect(jobs.every((job) => job.name && job.description && job.schedule)).toBe(true);
  });

  test('throws JobNotFoundError for unknown job', async () => {
    await expect(triggerJob('not-a-real-job')).rejects.toThrow(JobNotFoundError);
  });

  test('does not expose cascade-owned no-op jobs as manual triggers', async () => {
    const removed = [
      'tournament-event-transfers-post-sync',
      'tournament-event-cup-results-sync',
      'tournament-points-race-results-sync',
      'tournament-battle-race-results-sync',
      'tournament-knockout-results-sync',
    ];
    const triggerableNames = listTriggerableJobs().map((job) => job.name);
    for (const name of removed) {
      expect(triggerableNames).not.toContain(name);
      await expect(triggerJob(name)).rejects.toThrow(JobNotFoundError);
    }
  });

  test('does not expose scheduler-only Understat jobs as manual triggers', async () => {
    const schedulerOnly = [
      'understat-team-incremental',
      'understat-player-incremental',
      'understat-orphan-reconciler',
    ];
    const triggerableNames = listTriggerableJobs().map((job) => job.name);
    for (const name of schedulerOnly) {
      expect(triggerableNames).not.toContain(name);
      await expect(triggerJob(name)).rejects.toThrow(JobNotFoundError);
    }
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

  test('validates market source-day input before reading platform state', async () => {
    for (const name of ['market-daily', 'player-values-sync']) {
      await expect(triggerJob(name, { sourceDay: '2026-08-25' })).rejects.toMatchObject({
        name: 'ValidationError',
        code: 'MARKET_SOURCE_DAY_INVALID',
      });
    }
  });
});
