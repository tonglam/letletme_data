import { describe, expect, test } from 'bun:test';

import { loadBriefingManifest } from '../../../src/content/acquisition/acquisition-manifest';
import { compileBriefingRegistryState } from '../../../src/content/acquisition/registry-state';

describe('Briefing acquisition registry state', () => {
  test('compiles one deterministic recurring schedule per X partition or public feed endpoint', async () => {
    const bundle = await loadBriefingManifest();
    const state = compileBriefingRegistryState(bundle);

    expect(state.entities).toHaveLength(85);
    expect(state.endpoints).toHaveLength(108);
    expect(state.partitions).toHaveLength(44);
    expect(state.schedules).toHaveLength(65);
    expect(new Set(state.schedules.map((schedule) => schedule.scheduleKey)).size).toBe(65);
    expect(
      state.schedules.reduce<Record<string, number>>((counts, schedule) => {
        counts[schedule.jobKind] = (counts[schedule.jobKind] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({
      FEED_POLL: 21,
      X_KEYWORD_SCAN: 40,
      X_SEMANTIC_SCAN: 4,
    });
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
  });
});
