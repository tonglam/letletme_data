import { describe, expect, test } from 'bun:test';

import { liveFinalRetentionObligationStatuses } from '../../src/repositories/scheduler-obligations';

describe('live final retention obligation status projection', () => {
  test('keeps the latest failed evidence alongside the latest successful certificate', async () => {
    const failedEvidence = {
      retentionPolicyVersion: 'active-season-v1',
      retention: {
        schemaVersion: 'live-final-retention-v2',
        complete: false,
        failed: 3,
      },
    };
    const successfulEvidence = {
      retentionPolicyVersion: 'active-season-v1',
      retention: {
        schemaVersion: 'live-final-retention-v2',
        complete: true,
        failed: 0,
      },
    };
    const rows = [
      {
        scopeKey: '2627:event:1',
        periodKey: 'cycle-2',
        status: 'failed',
        dueAt: '2099-09-05T00:17:00.000Z',
        generation: 1,
        attempts: 2,
        lastError: 'bounded failure',
        nextAttemptAt: null,
        completedAt: '2026-09-05T00:20:00.000Z',
        evidence: failedEvidence,
        rowRank: 1,
        firstSucceededAt: '2026-09-04T00:20:00.000Z',
        lastSucceededAt: '2026-09-04T00:20:00.000Z',
      },
      {
        scopeKey: '2627:event:1',
        periodKey: 'cycle-1',
        status: 'succeeded',
        dueAt: '2026-09-04T00:17:00.000Z',
        generation: 0,
        attempts: 1,
        lastError: null,
        nextAttemptAt: null,
        completedAt: '2026-09-04T00:20:00.000Z',
        evidence: successfulEvidence,
        rowRank: 2,
        firstSucceededAt: '2026-09-04T00:20:00.000Z',
        lastSucceededAt: '2026-09-04T00:20:00.000Z',
      },
    ];
    const db = { execute: async () => rows } as never;

    const statuses = await liveFinalRetentionObligationStatuses({
      scopeKeys: ['2627:event:1', '2627:event:2'],
      policyVersion: 'active-season-v1',
      evidenceSchemaVersion: 'live-final-retention-v2',
      db,
    });

    expect(statuses.get('2627:event:1')).toMatchObject({
      latest: { status: 'failed', evidence: failedEvidence },
      latestSuccess: { status: 'succeeded', evidence: successfulEvidence },
      consecutiveUnsuccessfulCycles: 1,
      overdue: false,
    });
    expect(statuses.get('2627:event:1')?.firstSucceededAt?.toISOString()).toBe(
      '2026-09-04T00:20:00.000Z',
    );
    expect(statuses.get('2627:event:2')).toMatchObject({
      latest: null,
      latestSuccess: null,
      consecutiveUnsuccessfulCycles: 0,
    });
  });
});
