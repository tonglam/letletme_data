import { describe, expect, test } from 'bun:test';

import { readEventPinnedIdentity } from '../../src/repositories/fpl-player-fixture-stats';
import { transformFplPlayerFixtureEvidence } from '../../src/transformers/fpl-player-fixture-stats';
import { rawExplainElementsFixture } from '../fixtures/event-live-explains.fixtures';

describe('FPL per-fixture evidence transformer', () => {
  test('keeps double-gameweek fixtures separate before event aggregation', () => {
    const rows = transformFplPlayerFixtureEvidence(99, rawExplainElementsFixture);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.fixtureId === 401)).toMatchObject({
      elementId: 101,
      minutes: 90,
      starts: null,
      goals: 1,
      assists: 1,
    });
    expect(rows.find((row) => row.fixtureId === 402)).toMatchObject({
      elementId: 101,
      minutes: 0,
      starts: null,
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

describe('FPL per-fixture identity repository', () => {
  test('starts the statement timeout only after a pool connection is reserved', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const expected = [
      {
        fixtureId: 401,
        elementId: 101,
        teamId: 7,
        elementType: 3,
        price: 75,
        webName: 'Example',
      },
    ];
    const transaction = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: strings.join('?'), values });
      return statements.length === 1 ? [] : expected;
    };
    const client = {
      begin: async (operation: (sql: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    };

    const rows = await readEventPinnedIdentity(client as never, 2026, 3);

    expect(rows).toEqual(expected);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.text).toContain(String.raw`set_config('statement_timeout'`);
    expect(statements[0]?.values).toEqual(['2000ms']);
    expect(statements[1]?.text).toContain('FROM fpl.player_fixture_stats');
    expect(statements[1]?.values).toEqual([2026, 3]);
  });

  test('uses an existing transaction without starting a nested transaction', async () => {
    const statements: string[] = [];
    const transaction = async (strings: TemplateStringsArray) => {
      statements.push(strings.join('?'));
      return [];
    };

    await readEventPinnedIdentity(transaction as never, 2026, 3);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('FROM fpl.player_fixture_stats');
  });
});
