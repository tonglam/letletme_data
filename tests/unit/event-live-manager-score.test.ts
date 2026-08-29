import { describe, expect, test } from 'bun:test';

import {
  deriveEventLiveManagerScore,
  type EventLiveManagerPick,
} from '../../src/domain/event-live-manager-score';
import {
  buildScoreInputRevision,
  eventLiveHeartbeatIsFresh,
  eventLivePicksAreFresh,
  eventLiveProjectedPicksAreCoherent,
  hasCompleteAggregateCoverage,
} from '../../src/services/event-live-manager-scores.service';

const PICKED_POINTS = new Map([
  [529, 1],
  [8, 9],
  [388, 10],
  [423, 1],
  [427, 2],
  [480, 2],
  [557, 6],
  [40, 0],
  [542, 2],
  [411, 2],
  [106, 0],
  [600, 8],
  [601, 5],
  [602, 3],
  [603, 1],
]);

const picks = (transferCost = 0): EventLiveManagerPick[] =>
  [...PICKED_POINTS.keys()].map((elementId, index) => ({
    entryId: 109967,
    position: index + 1,
    elementId,
    multiplier: index < 11 ? (elementId === 411 ? 2 : 1) : 0,
    isCaptain: elementId === 411,
    isViceCaptain: elementId === 388,
    transfersCost: index === 0 ? transferCost : null,
    sourceUpdatedAt: new Date('2026-08-24T00:00:30.000Z'),
  }));

describe('event-live manager score authority', () => {
  test('reproduces the real 37-point sample from official player totals and multipliers', () => {
    expect(deriveEventLiveManagerScore(109967, picks(), PICKED_POINTS)).toEqual({
      entryId: 109967,
      eventPoints: 37,
      netEventPoints: 37,
      transferCost: 0,
      picksCheckedAt: '2026-08-24T00:00:30.000Z',
    });
  });

  test('deducts transfer cost only after deriving the gross event-live score', () => {
    expect(deriveEventLiveManagerScore(109967, picks(4), PICKED_POINTS)).toMatchObject({
      eventPoints: 37,
      netEventPoints: 33,
      transferCost: 4,
    });
  });

  test('fails closed for incomplete player coverage or a mixed picks publication', () => {
    const incompletePoints = new Map(PICKED_POINTS);
    incompletePoints.delete(411);
    expect(deriveEventLiveManagerScore(109967, picks(), incompletePoints)).toBeNull();

    const mixedPicks = picks();
    mixedPicks[14] = {
      ...mixedPicks[14]!,
      sourceUpdatedAt: new Date('2026-08-24T00:00:31.000Z'),
    };
    expect(deriveEventLiveManagerScore(109967, mixedPicks, PICKED_POINTS)).toBeNull();
  });

  test('requires contiguous prior-event evidence before publishing an overall total', () => {
    expect(
      hasCompleteAggregateCoverage({ eventCount: 7, firstEventId: 1, lastEventId: 7 }, 1, 7),
    ).toBe(true);
    expect(
      hasCompleteAggregateCoverage({ eventCount: 6, firstEventId: 1, lastEventId: 7 }, 1, 7),
    ).toBe(false);
  });

  test('rejects picks that have not been refreshed near the live publication', () => {
    expect(eventLivePicksAreFresh('2026-08-24T00:00:00.000Z', '2026-08-24T00:14:59.999Z')).toBe(
      true,
    );
    expect(eventLivePicksAreFresh('2026-08-24T00:00:00.001Z', '2026-08-24T00:00:00.000Z')).toBe(
      false,
    );
    expect(eventLivePicksAreFresh('2026-08-24T00:00:00.000Z', '2026-08-24T00:15:00.001Z')).toBe(
      false,
    );
    expect(eventLivePicksAreFresh('2026-08-24T00:15:00.001Z', '2026-08-24T00:00:00.000Z')).toBe(
      false,
    );
  });

  test('reuses coherent event picks for projected auto-subs across later live heartbeats', () => {
    expect(
      eventLiveProjectedPicksAreCoherent('2026-08-24T00:00:00.000Z', '2026-08-24T06:00:00.000Z'),
    ).toBe(true);
    expect(
      eventLiveProjectedPicksAreCoherent('2026-08-24T06:00:00.001Z', '2026-08-24T06:00:00.000Z'),
    ).toBe(false);
    expect(eventLiveProjectedPicksAreCoherent('invalid', '2026-08-24T06:00:00.000Z')).toBe(false);
  });

  test('rejects an expired or future event-live heartbeat', () => {
    const now = Date.parse('2026-08-24T00:01:30.001Z');
    expect(eventLiveHeartbeatIsFresh('2026-08-24T00:00:00.001Z', now)).toBe(true);
    expect(eventLiveHeartbeatIsFresh('2026-08-24T00:00:00.000Z', now)).toBe(false);
    expect(eventLiveHeartbeatIsFresh('2026-08-24T00:01:30.002Z', now)).toBe(false);
  });

  test('changes the score revision when a prior total is corrected', () => {
    const input = {
      algorithmVersion: 'fpl-projected-autosubs-v1',
      authorityRevision: 'fpl:live:publication-8:8',
      entryId: 109967,
      picks: picks(),
      previousTotal: 100,
      previousTotalsThroughEventId: 7,
    };
    expect(buildScoreInputRevision(input).inputRevision).not.toBe(
      buildScoreInputRevision({ ...input, previousTotal: 104 }).inputRevision,
    );
  });

  test('keeps a content revision stable across freshness-only picks observations', () => {
    const content = {
      algorithmVersion: 'fpl-projected-autosubs-v1',
      authorityRevision: 'fpl:live:publication-8:8',
      entryId: 109967,
      picks: picks(),
      previousTotal: 100,
      previousTotalsThroughEventId: 7,
    };
    const firstObservation = {
      ...content,
      picks: content.picks.map((pick) => ({
        ...pick,
        sourceUpdatedAt: new Date('2026-08-24T00:00:30.000Z'),
      })),
    };
    const laterObservation = {
      ...content,
      picks: content.picks.map((pick) => ({
        ...pick,
        sourceUpdatedAt: new Date('2026-08-24T00:10:30.000Z'),
      })),
    };

    expect(buildScoreInputRevision(firstObservation).inputRevision).toBe(
      buildScoreInputRevision(laterObservation).inputRevision,
    );
  });

  test('keeps input revision stable across heartbeat-only source timestamps', () => {
    const base = {
      algorithmVersion: 'fpl-projected-autosubs-v1',
      authorityRevision: 'fpl:live:publication-8:8',
      entryId: 109967,
      picks: picks(),
      previousTotal: 100,
      previousTotalsThroughEventId: 7,
      previousResultEvidence: [
        {
          entryId: 109967,
          eventId: 7,
          sourceResultId: 7001,
          eventNetPoints: 58,
          richSyncedAt: new Date('2026-08-24T00:00:00.000Z'),
          updatedAt: new Date('2026-08-24T00:00:01.000Z'),
        },
      ],
    };
    const later = {
      ...base,
      picks: base.picks.map((pick) => ({
        ...pick,
        sourceUpdatedAt: new Date('2026-08-24T00:10:00.000Z'),
      })),
      previousResultEvidence: base.previousResultEvidence.map((result) => ({
        ...result,
        richSyncedAt: new Date('2026-08-24T00:10:00.000Z'),
        updatedAt: new Date('2026-08-24T00:10:01.000Z'),
      })),
    };
    expect(buildScoreInputRevision(base).inputRevision).toBe(
      buildScoreInputRevision(later).inputRevision,
    );
    expect(
      buildScoreInputRevision({
        ...base,
        picks: base.picks.map((pick, index) =>
          index === 1 ? { ...pick, multiplier: pick.multiplier + 1 } : pick,
        ),
      }).inputRevision,
    ).not.toBe(buildScoreInputRevision(base).inputRevision);
  });
});
