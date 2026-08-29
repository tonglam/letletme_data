import { describe, expect, test } from 'bun:test';

import {
  projectOfficialH2HEventLiveScores,
  type OfficialH2HSourceSnapshot,
} from '../../src/services/tournament-official-h2h.service';
import type { EventLiveScoreBatch } from '../../src/services/event-live-v2-score.service';

const snapshot = (entry2: number | null = 34299): OfficialH2HSourceSnapshot => ({
  standings: [],
  matches: [
    {
      id: 2071743,
      event: 1,
      entry_1_entry: 109967,
      entry_1_points: 23,
      entry_2_entry: entry2,
      entry_2_points: entry2 === null ? null : 17,
      winner: 109967,
      knockout_name: null,
      sourceOrder: 0,
    },
  ],
});

const batch = (
  scores: ReadonlyMap<
    number,
    { eventPoints: number; netEventPoints: number; transferCost: number }
  >,
): EventLiveScoreBatch => ({
  season: '2627',
  eventId: 1,
  state: 'live',
  scoreCoreRevision: 'a'.repeat(64),
  generation: 8,
  publicationId: '00000000-0000-4000-8000-000000000008',
  sourceCheckedAt: '2026-08-24T00:01:00.000Z',
  calculationMode: 'PROJECTED_AUTOSUBS',
  algorithmVersion: 'live-points-v2-algorithm-1',
  scores: new Map(
    [...scores.entries()].map(([entryId, score]) => [
      entryId,
      {
        ...score,
        entryId,
        totalPoints: score.netEventPoints,
        picksCheckedAt: '2026-08-24T00:00:30.000Z',
        revision: `score-${entryId}`,
      },
    ]),
  ),
});

describe('Official H2H Live Points V2 projection', () => {
  test('overlays only complete same-event V2 scores', () => {
    const projected = projectOfficialH2HEventLiveScores(
      snapshot(),
      1,
      new Set([109967, 34299]),
      batch(
        new Map([
          [109967, { eventPoints: 37, netEventPoints: 37, transferCost: 0 }],
          [34299, { eventPoints: 31, netEventPoints: 31, transferCost: 0 }],
        ]),
      ),
    );
    expect(projected?.matches[0]).toMatchObject({
      entry_1_points: 37,
      entry_2_points: 31,
      winner: 109967,
    });
  });

  test('fails closed for an incomplete roster or all-zero placeholder', () => {
    expect(
      projectOfficialH2HEventLiveScores(
        snapshot(),
        1,
        new Set([109967, 34299]),
        batch(
          new Map([
            [109967, { eventPoints: 0, netEventPoints: 0, transferCost: 0 }],
            [34299, { eventPoints: 0, netEventPoints: 0, transferCost: 0 }],
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      projectOfficialH2HEventLiveScores(
        snapshot(null),
        1,
        new Set([109967]),
        batch(new Map([[109967, { eventPoints: 37, netEventPoints: 37, transferCost: 0 }]])),
      ),
    ).toBeNull();
  });
});
