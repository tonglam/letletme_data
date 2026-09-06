import { describe, expect, test } from 'bun:test';

import {
  schedulerObligationRecoveryFromEvidence,
  schedulerObligationRecoveryMatches,
} from '../../src/repositories/scheduler-obligations';

describe('scheduler obligation recovery evidence', () => {
  test('accepts a complete recovery marker', () => {
    expect(
      schedulerObligationRecoveryFromEvidence({
        schedulerRecovery: {
          status: 'succeeded',
          recoveredAt: '2026-09-06T05:00:00Z',
          recoveryRevision: '98',
          obligationId: '00000000-0000-4000-8000-000000000001',
          periodKey: '2627:event:2',
          generation: 1,
          recoveryActor: 'codex-production-recovery',
          recoveryReason: 'repair official final auto-substitution order',
        },
      }),
    ).toEqual({
      status: 'succeeded',
      recoveredAt: '2026-09-06T05:00:00Z',
      recoveryRevision: '98',
      obligationId: '00000000-0000-4000-8000-000000000001',
      periodKey: '2627:event:2',
      generation: 1,
      recoveryActor: 'codex-production-recovery',
      recoveryReason: 'repair official final auto-substitution order',
    });
  });

  test('rejects malformed or incomplete recovery markers', () => {
    expect(schedulerObligationRecoveryFromEvidence(undefined)).toBeNull();
    expect(
      schedulerObligationRecoveryFromEvidence({
        schedulerRecovery: {
          status: 'succeeded',
          recoveredAt: 'not-a-date',
          recoveryRevision: '98',
        },
      }),
    ).toBeNull();
    expect(
      schedulerObligationRecoveryFromEvidence({
        schedulerRecovery: {
          status: 'succeeded',
          recoveredAt: '2026-09-06T05:00:00+00:00',
          recoveryRevision: '98',
          obligationId: '00000000-0000-4000-8000-000000000001',
          periodKey: '2627:event:2',
          generation: 1,
        },
      }),
    ).toBeNull();
    expect(
      schedulerObligationRecoveryFromEvidence({
        schedulerRecovery: {
          status: 'failed',
          recoveredAt: '2026-09-06T05:00:00Z',
          recoveryRevision: '98',
        },
      }),
    ).toBeNull();
  });

  test('requires the recovery marker to match the exact obligation identity', () => {
    const evidence = {
      schedulerRecovery: {
        status: 'succeeded',
        recoveredAt: '2026-09-06T05:00:00Z',
        recoveryRevision: '98',
        obligationId: '00000000-0000-4000-8000-000000000001',
        periodKey: '2627:event:2',
        generation: 1,
      },
    };
    expect(
      schedulerObligationRecoveryMatches(evidence, {
        obligationId: '00000000-0000-4000-8000-000000000001',
        periodKey: '2627:event:2',
        generation: 1,
      }),
    ).not.toBeNull();
    expect(
      schedulerObligationRecoveryMatches(evidence, {
        obligationId: '00000000-0000-4000-8000-000000000002',
        periodKey: '2627:event:2',
        generation: 1,
      }),
    ).toBeNull();
  });
});
