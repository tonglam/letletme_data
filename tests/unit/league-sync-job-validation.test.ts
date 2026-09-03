import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { UnrecoverableError } from 'bullmq';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';
import {
  InvalidLeagueSyncJobError,
  LeagueSyncJobDataSchema,
  INVALID_LEAGUE_SYNC_JOB_CODE,
  validateLeagueSyncJobData,
} from '../../src/queues/league-sync-job-contract';
import { buildLeagueSyncJobData } from '../../src/jobs/league-sync.jobs';

const validPayload = {
  seasonId: TEST_SEASON.seasonId,
  seasonCode: TEST_SEASON.seasonCode,
  eventId: 1,
  source: 'catchup' as const,
  triggeredAt: '2026-09-03T10:00:00.000Z',
  runId: 'run-1',
  obligationId: '00000000-0000-4000-8000-000000000001',
  obligationGeneration: 2,
  freshnessWindowId: 3,
  extraField: 'preserved',
};

describe('league sync job payload validation', () => {
  test('accepts valid payloads and preserves forward-compatible fields', () => {
    const parsed = LeagueSyncJobDataSchema.parse(validPayload);

    expect(parsed).toMatchObject(validPayload);
    expect(parsed.extraField).toBe('preserved');
  });

  test('rejects malformed IDs, dates, sources, and scheduler generations', () => {
    const invalid = [
      { ...validPayload, seasonId: 0 },
      { ...validPayload, seasonCode: 'invalid' },
      { ...validPayload, eventId: undefined },
      { ...validPayload, tournamentId: 0 },
      { ...validPayload, source: 'unknown' },
      { ...validPayload, triggeredAt: 'not-a-timestamp' },
      { ...validPayload, runId: '' },
      { ...validPayload, obligationId: '' },
      { ...validPayload, obligationId: 'not-a-uuid' },
      { ...validPayload, obligationId: undefined },
      { ...validPayload, obligationGeneration: undefined },
      { ...validPayload, obligationGeneration: -1 },
      { ...validPayload, freshnessWindowId: 0 },
    ];

    for (const payload of invalid) {
      expect(() => validateLeagueSyncJobData(payload)).toThrow(
        'League sync job payload is invalid.',
      );
      expect(LeagueSyncJobDataSchema.safeParse(payload).success).toBe(false);
    }
  });

  test('validates before building a deterministic event-based job identity', () => {
    expect(() =>
      buildLeagueSyncJobData(TEST_SEASON, undefined as unknown as number, 'cron', {}),
    ).toThrow('League sync job payload is invalid.');
  });

  test('uses an unrecoverable worker error for malformed retained jobs', () => {
    const error = new InvalidLeagueSyncJobError();

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.code).toBe(INVALID_LEAGUE_SYNC_JOB_CODE);
    expect(error.name).toBe('InvalidLeagueSyncJobError');
  });

  test('worker validates payload before scheduler or database calls', () => {
    const source = readFileSync('src/workers/league-sync.worker.ts', 'utf8');
    const parseIndex = source.indexOf('const data = parseLeagueSyncWorkerJob(job);');
    const schedulerIndex = source.indexOf('startCurrentSchedulerJob(data, {');
    const seasonIndex = source.indexOf('requireCurrentSeasonForJob(data)');

    expect(parseIndex).toBeGreaterThan(-1);
    expect(parseIndex).toBeLessThan(schedulerIndex);
    expect(parseIndex).toBeLessThan(seasonIndex);
    expect(source).toContain(
      'failSchedulerObligationByBullJobId({ bullJobId: job.id, error: err })',
    );
  });
});
