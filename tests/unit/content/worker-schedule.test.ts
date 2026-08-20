import { describe, expect, test } from 'bun:test';

import {
  computePollWindow,
  isPollDue,
  pollBudget,
  resolvePollPhase,
} from '../../../src/content/poll-policy';
import { isAcquisitionRunStale } from '../../../src/content/acquisition/run-repository';
import { assertContentRuntimeFlags, type ContentRuntimeFlags } from '../../../src/content/config';

const now = new Date('2026-08-20T10:00:00.000Z');

describe('content worker poll policy', () => {
  test('rejects a per-run X-call ceiling above the tracked Grok schema limit', () => {
    const flags: ContentRuntimeFlags = {
      pipelineEnabled: true,
      realGrokEnabled: false,
      publicationEnabled: false,
      briefingPublicEnabled: false,
      grokConcurrency: 1,
      pollMaxXCalls: 21,
      dailyXCallBudget: 24,
      revalidationUrl: null,
      revalidationSecret: null,
      editorApiKeyHashes: [],
      publisherApiKeyHashes: [],
    };
    expect(() => assertContentRuntimeFlags(flags)).toThrow('from 1 to 20');
  });

  test('keeps FINAL_90 disabled unless a future duty window and budget are recorded', () => {
    const deadlineAt = '2026-08-20T11:00:00.000Z';
    const base = { deadlineAt, final90Enabled: true, final90Budget: 2 };
    expect(resolvePollPhase(base, now)).toBe('APPROACHING');
    expect(resolvePollPhase({ ...base, editorOnDutyUntil: '2026-08-20T10:30:00.000Z' }, now)).toBe(
      'FINAL_90',
    );
  });

  test('uses safety lag, overlap and a bounded catch-up window', () => {
    const window = computePollWindow({
      policy: { safetyLagMinutes: 2, overlapMinutes: 5, maxCatchupMinutes: 60 },
      phase: 'NORMAL',
      now,
      checkpointEnd: new Date('2026-08-20T06:00:00.000Z'),
    });
    expect(window.windowEnd.toISOString()).toBe('2026-08-20T09:58:00.000Z');
    expect(window.windowStart.toISOString()).toBe('2026-08-20T08:58:00.000Z');
  });

  test('does not enqueue again before the phase-specific cadence elapses', () => {
    const checkpointEnd = new Date('2026-08-20T09:45:00.000Z');
    const policy = { normalMinutes: 30, approachingMinutes: 10, safetyLagMinutes: 2 };
    expect(isPollDue({ policy, phase: 'NORMAL', now, checkpointEnd })).toBe(false);
    expect(
      isPollDue({
        policy,
        phase: 'NORMAL',
        now: new Date('2026-08-20T10:17:00.000Z'),
        checkpointEnd,
      }),
    ).toBe(true);
    expect(isPollDue({ policy, phase: 'APPROACHING', now, checkpointEnd })).toBe(true);
  });

  test('returns a phase budget only for an enabled FINAL_90 policy', () => {
    expect(pollBudget({ final90Budget: 3 }, 'NORMAL')).toBeNull();
    expect(pollBudget({ final90Budget: 3 }, 'FINAL_90')).toBe(3);
    expect(pollBudget({ final90Budget: 0 }, 'FINAL_90')).toBeNull();
  });

  test('reclaims only acquisition runs whose lease anchor is stale', () => {
    const now = new Date('2026-08-20T10:00:00.000Z');
    expect(
      isAcquisitionRunStale({
        startedAt: new Date('2026-08-20T09:55:00.001Z'),
        createdAt: now,
        now,
      }),
    ).toBe(false);
    expect(
      isAcquisitionRunStale({
        startedAt: new Date('2026-08-20T09:55:00.000Z'),
        createdAt: now,
        now,
      }),
    ).toBe(true);
    expect(
      isAcquisitionRunStale({
        startedAt: null,
        createdAt: new Date('2026-08-20T09:55:00.001Z'),
        now,
      }),
    ).toBe(false);
  });
});
