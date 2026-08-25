import { describe, expect, test } from 'bun:test';

import {
  shouldCascadePersistedLiveSnapshot,
  shouldSkipQueuedLiveSnapshot,
} from '../../src/domain/live-snapshot';
import {
  buildCurrentSeasonPlayerTeamMap,
  livePublicationMatchesFinalizedCheckpoint,
  prepareLiveSnapshot,
  shouldAdvanceLivePublication,
  type LiveSnapshotReferenceData,
} from '../../src/services/live-snapshot.service';
import type { RawFPLFixture } from '../../src/types';
import { mockEventLiveResponseFixture } from '../fixtures/event-lives.fixtures';
import { mockRawFPLFixture1 } from '../fixtures/fixtures.fixtures';

function liveRawFixture(overrides: Partial<RawFPLFixture> = {}): RawFPLFixture {
  return {
    ...mockRawFPLFixture1,
    event: 1,
    started: true,
    finished: false,
    finished_provisional: false,
    minutes: 54,
    team_h_score: 2,
    team_a_score: 1,
    stats: [
      ...mockRawFPLFixture1.stats,
      {
        identifier: 'bps',
        h: [
          { element: 350, value: 45 },
          { element: 567, value: 5 },
        ],
        a: [{ element: 234, value: 28 }],
      },
    ],
    ...overrides,
  };
}

function referenceData(): LiveSnapshotReferenceData {
  return {
    season: '2526',
    nameById: new Map([
      [4, 'Burnley'],
      [12, 'Liverpool'],
    ]),
    shortNameById: new Map([
      [4, 'BUR'],
      [12, 'LIV'],
    ]),
    positionById: new Map([
      [4, 16],
      [12, 1],
    ]),
    playerTeamById: new Map([
      [350, 12],
      [234, 4],
      [567, 12],
    ]),
  };
}

describe('live snapshot preparation', () => {
  test('requires a finalized publication to bind the exact immutable checkpoint', () => {
    const finalizedAt = new Date('2026-08-25T16:08:07.277Z');

    expect(livePublicationMatchesFinalizedCheckpoint(null, null)).toBe(true);
    expect(
      livePublicationMatchesFinalizedCheckpoint(
        { sourceCheckedAt: finalizedAt.toISOString() },
        finalizedAt,
      ),
    ).toBe(true);
    expect(
      livePublicationMatchesFinalizedCheckpoint(
        { sourceCheckedAt: '2026-08-25T08:09:03.469Z' },
        finalizedAt,
      ),
    ).toBe(false);
    expect(
      livePublicationMatchesFinalizedCheckpoint({ sourceCheckedAt: 'invalid' }, finalizedAt),
    ).toBe(false);
    expect(livePublicationMatchesFinalizedCheckpoint(null, finalizedAt)).toBe(false);
  });

  test('advances the publication for finalization even when content is unchanged', () => {
    expect(shouldAdvanceLivePublication(false, undefined)).toBe(false);
    expect(shouldAdvanceLivePublication(false, false)).toBe(false);
    expect(shouldAdvanceLivePublication(true, false)).toBe(true);
    expect(shouldAdvanceLivePublication(false, true)).toBe(true);
  });

  test('builds identity only from one complete explicit-season roster', () => {
    expect(
      buildCurrentSeasonPlayerTeamMap(
        [
          { id: 350, teamId: 12 },
          { id: 234, teamId: 4 },
        ],
        '2526',
      ),
    ).toEqual(
      new Map([
        [350, 12],
        [234, 4],
      ]),
    );
    expect(() =>
      buildCurrentSeasonPlayerTeamMap(
        [
          { id: 350, teamId: 12 },
          { id: 350, teamId: 4 },
        ],
        '2526',
      ),
    ).toThrow('duplicate player IDs');
    expect(() => buildCurrentSeasonPlayerTeamMap([{ id: 0, teamId: 12 }], '2526')).toThrow(
      'invalid identity',
    );
  });

  test('publishes only official event-live totals and fixtures from one upstream pair', () => {
    const prepared = prepareLiveSnapshot(
      1,
      mockEventLiveResponseFixture,
      [liveRawFixture()],
      referenceData(),
      [1],
    );

    expect(prepared.season).toBe('2526');
    expect(prepared.eventId).toBe(1);
    expect(prepared.state).toBe('live');
    expect(prepared.eventLives.eventLives).toHaveLength(3);
    expect(prepared.fixtures).toHaveLength(1);
    expect(prepared.eventLives.eventLives.find((row) => row.elementId === 350)?.totalPoints).toBe(
      15,
    );
  });

  test('derives scheduled, live, and settled state only from the fixture batch', () => {
    const prepare = (fixture: RawFPLFixture) =>
      prepareLiveSnapshot(1, mockEventLiveResponseFixture, [fixture], referenceData(), [1]).state;

    expect(
      prepare(
        liveRawFixture({
          started: null,
          finished: false,
          finished_provisional: false,
          minutes: 0,
        }),
      ),
    ).toBe('scheduled');
    expect(
      prepareLiveSnapshot(
        1,
        mockEventLiveResponseFixture,
        [
          liveRawFixture({ finished_provisional: true, minutes: 90 }),
          liveRawFixture({
            id: mockRawFPLFixture1.id + 1,
            started: false,
            minutes: 0,
            team_h_score: null,
            team_a_score: null,
          }),
        ],
        referenceData(),
        [1, 2],
      ).state,
    ).toBe('live');
    expect(prepare(liveRawFixture())).toBe('live');
    expect(
      prepare(
        liveRawFixture({
          started: true,
          finished: true,
          finished_provisional: true,
          minutes: 90,
        }),
      ),
    ).toBe('settled');
  });

  test('rejects duplicate, missing, or unexpected player identity', () => {
    expect(() =>
      prepareLiveSnapshot(
        1,
        {
          elements: [
            ...mockEventLiveResponseFixture.elements,
            mockEventLiveResponseFixture.elements[0],
          ],
        },
        [liveRawFixture()],
        referenceData(),
        [1],
      ),
    ).toThrow('Duplicate player identity');

    expect(() =>
      prepareLiveSnapshot(
        1,
        { elements: mockEventLiveResponseFixture.elements.slice(0, -1) },
        [liveRawFixture()],
        referenceData(),
        [1],
      ),
    ).toThrow('missing=567; unexpected=none');
  });

  test('retains a previously published event roster after the mutable core roster grows', () => {
    const references = referenceData();
    references.playerTeamById.set(611, 12);
    references.playerTeamById.set(612, 4);

    const prepared = prepareLiveSnapshot(
      1,
      mockEventLiveResponseFixture,
      [liveRawFixture()],
      references,
      [1],
      mockEventLiveResponseFixture.elements.map((element) => element.id),
    );

    expect(prepared.eventLives.eventLives).toHaveLength(3);
    expect(prepared.liveIdentityBaseline).toBe('published-event');
  });

  test('rejects live identity that matches neither current nor previously published roster', () => {
    const references = referenceData();
    references.playerTeamById.set(611, 12);

    expect(() =>
      prepareLiveSnapshot(
        1,
        { elements: mockEventLiveResponseFixture.elements.slice(0, -1) },
        [liveRawFixture()],
        references,
        [1],
        mockEventLiveResponseFixture.elements.map((element) => element.id),
      ),
    ).toThrow('missing=567,611; unexpected=none');
  });

  test('rejects mixed events and incomplete fixture identity', () => {
    expect(() =>
      prepareLiveSnapshot(
        1,
        mockEventLiveResponseFixture,
        [liveRawFixture({ event: 2 })],
        referenceData(),
        [1],
      ),
    ).toThrow('mixed event 2');

    expect(() =>
      prepareLiveSnapshot(
        1,
        mockEventLiveResponseFixture,
        [liveRawFixture()],
        referenceData(),
        [1, 2],
      ),
    ).toThrow('missing=2; unexpected=none');
  });

  test('rejects fixture teams absent from the core identity baseline', () => {
    const references = referenceData();
    references.nameById.delete(12);
    expect(() =>
      prepareLiveSnapshot(1, mockEventLiveResponseFixture, [liveRawFixture()], references, [1]),
    ).toThrow('Missing live team metadata for IDs 12');
  });
});

describe('live snapshot queue and cascade policy', () => {
  test('skips only cache-only cron work outside the match window', () => {
    expect(shouldSkipQueuedLiveSnapshot('cron', false, false)).toBe(true);
    expect(shouldSkipQueuedLiveSnapshot('cron', true, false)).toBe(false);
    expect(shouldSkipQueuedLiveSnapshot('manual', false, false)).toBe(false);
    expect(shouldSkipQueuedLiveSnapshot('cron', false, true)).toBe(false);
  });

  test('cascades from the durable checkpoint even when Redis lost freshness authority', () => {
    expect(shouldCascadePersistedLiveSnapshot({ stale: true, persistedEventLives: true })).toBe(
      true,
    );
    expect(shouldCascadePersistedLiveSnapshot({ stale: false, persistedEventLives: false })).toBe(
      false,
    );
  });
});
