import { describe, expect, test } from 'bun:test';

import { loadBriefingManifest } from '../../../src/content/acquisition/acquisition-manifest';
import {
  backstopSlotEndForDueAt,
  compileBriefingRegistryState,
  latestBackstopSlotEndAt,
  nextBackstopDueAt,
} from '../../../src/content/acquisition/registry-state';

describe('Briefing acquisition registry state', () => {
  test('compiles one deterministic recurring schedule per X partition or public feed endpoint', async () => {
    const bundle = await loadBriefingManifest();
    const state = compileBriefingRegistryState(bundle);

    expect(state.entities).toHaveLength(85);
    expect(state.endpoints).toHaveLength(108);
    expect(state.partitions).toHaveLength(44);
    expect(state.schedules).toHaveLength(105);
    expect(new Set(state.schedules.map((schedule) => schedule.scheduleKey)).size).toBe(105);
    expect(
      state.schedules.reduce<Record<string, number>>((counts, schedule) => {
        counts[schedule.jobKind] = (counts[schedule.jobKind] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({
      FEED_POLL: 21,
      X_KEYWORD_SCAN: 80,
      X_SEMANTIC_SCAN: 4,
    });
    expect(state.schedules.filter((schedule) => schedule.scheduleRole === 'PRIMARY')).toHaveLength(
      65,
    );
    expect(state.schedules.filter((schedule) => schedule.scheduleRole === 'BACKSTOP')).toHaveLength(
      40,
    );
    expect(
      state.schedules
        .filter((schedule) => schedule.scheduleRole === 'BACKSTOP')
        .every((schedule) => schedule.status === 'paused'),
    ).toBe(true);
  });

  test('keeps the source entity separate from its channel endpoints', async () => {
    const bundle = await loadBriefingManifest();
    const state = compileBriefingRegistryState(bundle);
    const focalEndpoints = state.endpoints.filter((endpoint) => endpoint.sourceKey === 'fpl-focal');

    expect(focalEndpoints.map((endpoint) => endpoint.adapterKind).sort()).toEqual([
      'X_ACCOUNT',
      'YOUTUBE_CHANNEL',
    ]);
    expect(state.entities.find((entity) => entity.sourceKey === 'fpl-focal')).toMatchObject({
      sourceType: 'CREATOR',
      reportingFamily: 'CREATOR',
    });
    expect(focalEndpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rightsPolicy: expect.objectContaining({
            mode: 'PUBLIC_ATTRIBUTED',
            allowPublic: true,
            allowFullText: true,
            attributionRequired: true,
          }),
        }),
      ]),
    );
  });

  test('adds exactly one 12-hour backstop for every X account partition', async () => {
    const bundle = await loadBriefingManifest();
    const state = compileBriefingRegistryState(bundle, { includeXBackstop: true });
    const backstops = state.schedules.filter((schedule) => schedule.scheduleRole === 'BACKSTOP');
    const accountPartitions = state.partitions.filter(
      (partition) => partition.adapterKind === 'X_ACCOUNT',
    );

    expect(accountPartitions).toHaveLength(40);
    expect(backstops).toHaveLength(accountPartitions.length);
    expect(new Set(backstops.map((schedule) => schedule.scheduleKey)).size).toBe(40);
    expect(backstops.every((schedule) => schedule.priority === 70)).toBe(true);
    expect(backstops.map((schedule) => schedule.scheduleKey).sort()).toEqual(
      accountPartitions.map((partition) => `partition-${partition.partitionKey}-backstop`).sort(),
    );
    expect(
      state.schedules
        .filter((schedule) => schedule.scheduleRole === 'BACKSTOP')
        .every((schedule) => schedule.status === 'active'),
    ).toBe(true);
  });

  test('anchors backstop windows to UTC slots with bounded deterministic jitter', () => {
    const now = new Date('2026-08-24T12:25:00.000Z');
    expect(latestBackstopSlotEndAt(now)).toEqual(new Date('2026-08-24T12:00:00.000Z'));
    const due = nextBackstopDueAt(now, 'partition-creators-core-backstop');
    expect(due.getTime()).toBeGreaterThan(new Date('2026-08-24T12:10:00.000Z').getTime());
    expect(due.getTime()).toBeLessThanOrEqual(new Date('2026-08-25T00:20:00.000Z').getTime());
    expect(nextBackstopDueAt(now, 'partition-creators-core-backstop')).toEqual(due);
  });

  test('recovers the overdue slot and bounds recovery to one missed 12-hour slot', () => {
    const scheduleKey = 'partition-creators-core-backstop';
    const now = new Date('2026-08-24T12:25:00.000Z');
    const dueForMidnight = nextBackstopDueAt(new Date('2026-08-23T23:00:00.000Z'), scheduleKey);
    expect(backstopSlotEndForDueAt({ now, scheduleKey, dueAt: dueForMidnight })).toEqual(
      new Date('2026-08-24T00:00:00.000Z'),
    );

    const veryOldDue = nextBackstopDueAt(new Date('2026-08-21T23:00:00.000Z'), scheduleKey);
    expect(backstopSlotEndForDueAt({ now, scheduleKey, dueAt: veryOldDue })).toEqual(
      new Date('2026-08-24T12:00:00.000Z'),
    );
  });
});
