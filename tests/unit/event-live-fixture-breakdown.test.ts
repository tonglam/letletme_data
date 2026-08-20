import { describe, expect, test } from 'bun:test';

import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';
import { prepareEventLives } from '../../src/services/event-lives.service';

describe('revision-pinned fixture breakdown', () => {
  test('keeps each double-gameweek fixture separate', () => {
    const prepared = prepareEventLives(99, rawExplainElementsFixture);
    const player = prepared.eventLives.find((row) => row.elementId === 101);
    expect(player?.fixtureBreakdown).toEqual([
      {
        fixtureId: 401,
        stats: [
          { identifier: 'minutes', value: 90, points: 2, pointsModification: -1 },
          { identifier: 'goals_scored', value: 1, points: 4, pointsModification: null },
          { identifier: 'assists', value: 1, points: 3, pointsModification: null },
          { identifier: 'defensive_contribution', value: 10, points: 2, pointsModification: null },
          { identifier: 'bonus', value: 0, points: 1, pointsModification: 1 },
        ],
      },
      {
        fixtureId: 402,
        stats: [{ identifier: 'clean_sheets', value: 1, points: 4, pointsModification: null }],
      },
    ]);
  });

  test('rejects duplicate fixture facts instead of silently merging them', () => {
    const duplicate = structuredClone(rawExplainElementsFixture[0]);
    if (!Array.isArray(duplicate.explain)) throw new Error('fixture is invalid');
    duplicate.explain.push(structuredClone(duplicate.explain[0]));
    expect(() => prepareEventLives(99, [duplicate])).toThrow('Duplicate live fixture breakdown');
  });
});
