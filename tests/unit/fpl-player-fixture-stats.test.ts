import { describe, expect, test } from 'bun:test';

import { transformFplPlayerFixtureEvidence } from '../../src/transformers/fpl-player-fixture-stats';
import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';

describe('FPL per-fixture evidence transformer', () => {
  test('keeps DGW fixtures separate before event aggregation', () => {
    const rows = transformFplPlayerFixtureEvidence(99, rawExplainElementsFixture);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.fixtureId === 401)).toMatchObject({
      elementId: 101,
      minutes: 90,
      goals: 1,
      assists: 1,
    });
    expect(rows.find((row) => row.fixtureId === 402)).toMatchObject({
      elementId: 101,
      minutes: 0,
      goals: 0,
      assists: 0,
    });
  });

  test('rejects duplicate element-fixture evidence instead of summing it', () => {
    const element = structuredClone(rawExplainElementsFixture[0]);
    if (!Array.isArray(element.explain)) throw new Error('fixture is invalid');
    element.explain.push(structuredClone(element.explain[0]));
    expect(() => transformFplPlayerFixtureEvidence(99, [element])).toThrow(
      'Duplicate FPL fixture explain',
    );
  });
});
