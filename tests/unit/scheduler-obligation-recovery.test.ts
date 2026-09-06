import { describe, expect, test } from 'bun:test';

import { schedulerObligationRecoveryFromEvidence } from '../../src/repositories/scheduler-obligations';

describe('scheduler obligation recovery evidence', () => {
  test('accepts a complete recovery marker', () => {
    expect(
      schedulerObligationRecoveryFromEvidence({
        schedulerRecovery: {
          status: 'succeeded',
          recoveredAt: '2026-09-06T05:00:00Z',
          recoveryRevision: '98',
          recoveryActor: 'codex-production-recovery',
          recoveryReason: 'repair official final auto-substitution order',
        },
      }),
    ).toEqual({
      status: 'succeeded',
      recoveredAt: '2026-09-06T05:00:00Z',
      recoveryRevision: '98',
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
          status: 'failed',
          recoveredAt: '2026-09-06T05:00:00Z',
          recoveryRevision: '98',
        },
      }),
    ).toBeNull();
  });
});
