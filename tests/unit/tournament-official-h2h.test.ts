import { describe, expect, test } from 'bun:test';

import {
  fetchOfficialH2HSourceSnapshot,
  overlayOfficialH2HAverageScore,
  overlayOfficialH2HAverageScores,
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
  test('captures source ordering before provider reads complete', async () => {
    let providerFinishedAt = 0;
    const client = {
      async getLeagueH2HStandings() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { standings: { results: [], has_next: false } };
      },
      async getLeagueH2HMatches() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        providerFinishedAt = Date.now();
        return { results: [], has_next: false };
      },
    } as unknown as Parameters<typeof fetchOfficialH2HSourceSnapshot>[1];

    const fetched = await fetchOfficialH2HSourceSnapshot(123, client);

    expect(fetched.sourceCheckedAt).toBeDefined();
    expect(fetched.sourceCheckedAt!.getTime()).toBeLessThan(providerFinishedAt);
  });

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

  test('does not use an official-feed Average Team score as a fallback', () => {
    const providerAverage = snapshot(null);
    providerAverage.matches[0].entry_2_points = 99;

    expect(
      projectOfficialH2HEventLiveScores(
        providerAverage,
        1,
        new Set([109967]),
        batch(new Map([[109967, { eventPoints: 37, netEventPoints: 37, transferCost: 0 }]])),
      ),
    ).toBeNull();

    const canonical = overlayOfficialH2HAverageScore(providerAverage, 1, 30);
    expect(canonical.matches[0]).toMatchObject({
      entry_2_points: 30,
      entry_1_total: 0,
      entry_2_total: 3,
      entry_1_win: 0,
      entry_2_win: 1,
      winner: null,
    });
    expect(
      projectOfficialH2HEventLiveScores(
        canonical,
        1,
        new Set([109967]),
        batch(new Map([[109967, { eventPoints: 37, netEventPoints: 37, transferCost: 0 }]])),
        30,
      )?.matches[0],
    ).toMatchObject({ entry_1_points: 37, entry_2_points: 30, winner: 109967 });

    expect(overlayOfficialH2HAverageScore(providerAverage, 1, null).matches[0]).toMatchObject({
      entry_2_points: null,
      winner: null,
    });
    expect(overlayOfficialH2HAverageScore(providerAverage, 1, null).matches[0].entry_1_total).toBe(
      undefined,
    );
  });

  test('keeps a tied real entry versus Average Team as a draw', () => {
    const tied = snapshot(null);
    tied.matches[0]!.entry_1_points = 30;

    expect(overlayOfficialH2HAverageScore(tied, 1, 30).matches[0]).toMatchObject({
      entry_1_draw: 1,
      entry_2_draw: 1,
      entry_1_total: 1,
      entry_2_total: 1,
      winner: null,
    });
  });

  test('overlays canonical Average Team scores across an eventless full repair', () => {
    const full = snapshot(null);
    full.matches.push({
      id: 2071744,
      event: 2,
      entry_1_entry: null,
      entry_1_points: 99,
      entry_2_entry: 34299,
      entry_2_points: 12,
      winner: 34299,
      knockout_name: null,
      sourceOrder: 1,
      is_bye: false,
    });

    const repaired = overlayOfficialH2HAverageScores(
      full,
      new Map([
        [1, 30],
        [2, 45],
      ]),
    );

    expect(repaired.matches[0]).toMatchObject({ entry_2_points: 30, winner: null });
    expect(repaired.matches[1]).toMatchObject({
      entry_1_points: 45,
      entry_1_win: 1,
      entry_2_loss: 1,
      winner: null,
    });
  });
});
