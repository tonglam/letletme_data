import { describe, expect, test } from 'bun:test';
import { validLiveFinalRetentionRecovery } from '../../src/domain/live-final-retention-policy';
import {
  appendSchedulerObligationRecovery,
  liveFinalRetentionObligationStatuses,
} from '../../src/repositories/scheduler-obligations';

function proof() {
  return {
    schemaVersion: 'live-final-retention-v2',
    policyVersion: 'active-season-v1',
    eventId: 3,
    status: 'succeeded',
    complete: true,
    failed: 0,
    requiredArtifacts: 5,
    checkedAt: '2026-09-09T00:00:00.000Z',
    minRemainingTtlMs: 900_000_000,
    families: Object.fromEntries(
      ['global', 'matchDesk', 'matchDetail', 'entry', 'league'].map((name) => [
        name,
        { checked: 1, renewed: 0, restored: 0, failed: 0, minRemainingTtlMs: 900_000_000 },
      ]),
    ),
  };
}
const target = {
  obligationId: '00000000-0000-4000-8000-000000000003',
  periodKey: 'cycle-3',
  generation: 2,
};
function row() {
  return {
    ...target,
    scopeKey: '2627:event:3',
    status: 'irrecoverable',
    dueAt: '2026-09-08T02:17:00Z',
    attempts: 3,
    lastError: 'retention incomplete',
    nextAttemptAt: null,
    completedAt: '2026-09-08T03:49:00Z',
    rowRank: 1,
    firstSucceededAt: null,
    lastSucceededAt: null,
    evidence: {
      retentionPolicyVersion: 'active-season-v1',
      retention: { complete: false, failed: 1718 },
      schedulerRecovery: {
        ...target,
        status: 'succeeded',
        recoveredAt: '2026-09-09T00:00:01.000Z',
        recoveryRevision: 'manual-3',
        retention: proof(),
      },
    },
  };
}
async function status(rows: ReturnType<typeof row>[]) {
  return (
    await liveFinalRetentionObligationStatuses({
      scopeKeys: ['2627:event:3'],
      policyVersion: 'active-season-v1',
      evidenceSchemaVersion: 'live-final-retention-v2',
      db: { execute: async () => structuredClone(rows) } as never,
    })
  ).get('2627:event:3')!;
}
describe('manual retention recovery proof', () => {
  test('projects a complete exact-target recovery and preserves historical failure', async () => {
    const original = row();
    const result = await status([original]);
    expect(result.latest?.status).toBe('succeeded');
    expect(result.latestSuccess?.evidence.retention).toEqual(proof());
    expect(result.consecutiveUnsuccessfulCycles).toBe(0);
    expect(result.firstSucceededAt?.toISOString()).toBe(proof().checkedAt);
    expect(original.status).toBe('irrecoverable');
    expect(original.evidence.retention.failed).toBe(1718);
  });
  test('a newer failed cycle is not hidden by an older recovered cycle', async () => {
    const older = row();
    const newer = row();
    newer.obligationId = '00000000-0000-4000-8000-000000000004';
    newer.periodKey = 'cycle-4';
    newer.rowRank = 1;
    older.rowRank = 2;
    const result = await status([newer, older]);
    expect(result.latest?.status).toBe('irrecoverable');
    expect(result.latestSuccess?.obligationId).toBe(older.obligationId);
    expect(result.consecutiveUnsuccessfulCycles).toBe(1);
  });
  test('rejects incomplete, wrong scope, incoherent and expired-lease proofs', () => {
    expect(validLiveFinalRetentionRecovery(proof(), '2627:event:3')).toBe(true);
    for (const patch of [
      { eventId: 2 },
      { failed: 1 },
      { complete: false },
      { requiredArtifacts: 6 },
      { checkedAt: 'invalid' },
      { minRemainingTtlMs: 1 },
      { families: {} },
      { policyVersion: 'wrong' },
    ]) {
      expect(validLiveFinalRetentionRecovery({ ...proof(), ...patch }, '2627:event:3')).toBe(false);
    }
  });
  test('recovery marker alone and changed exact identities never certify', async () => {
    for (const key of [
      'obligationId',
      'periodKey',
      'generation',
      'retention',
      'recoveredAt',
    ] as const) {
      const r = row();
      Object.assign(r.evidence.schedulerRecovery, {
        [key]: key === 'generation' ? 99 : key === 'retention' ? {} : 'wrong',
      });
      const result = await status([r]);
      expect(result.latest?.status).toBe('irrecoverable');
      expect(result.latestSuccess).toBeNull();
    }
  });
  test('refuses a manual acknowledgement without proof before any write', async () => {
    await expect(
      appendSchedulerObligationRecovery({
        ...target,
        jobName: 'live-final-retention',
        scopeKey: '2627:event:3',
        recoveryRevision: 'manual-3',
        recoveryActor: 'operator',
        recoveryReason: 'verify',
        db: {
          execute: () => {
            throw new Error('unexpected DB access');
          },
        } as never,
      }),
    ).rejects.toThrow('Complete live final retention recovery proof');
  });
  test('database persistence failure cannot acknowledge recovery', async () => {
    await expect(
      appendSchedulerObligationRecovery({
        ...target,
        jobName: 'live-final-retention',
        scopeKey: '2627:event:3',
        recoveryRevision: 'manual-3',
        recoveryActor: 'operator',
        recoveryReason: 'verify',
        retention: proof(),
        recoveredAt: new Date('2026-09-09T00:00:01.000Z'),
        db: {
          execute: async () => {
            throw new Error('write unavailable');
          },
        } as never,
      }),
    ).rejects.toThrow('write unavailable');
  });
  test('repeated completion is idempotent only for the same exact recovery revision', async () => {
    const existing = row().evidence;
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => [{ evidence: existing }],
    };
    const db = { execute: async () => [], select: () => chain } as never;
    const input = {
      ...target,
      jobName: 'live-final-retention',
      scopeKey: '2627:event:3',
      recoveryRevision: 'manual-3',
      recoveryActor: 'operator',
      recoveryReason: 'verify',
      retention: proof(),
      recoveredAt: new Date('2026-09-09T00:00:01Z'),
      db,
    };
    expect(await appendSchedulerObligationRecovery(input)).toBe(true);
    expect(
      await appendSchedulerObligationRecovery({ ...input, recoveryRevision: 'other-job' }),
    ).toBe(false);
  });
});
