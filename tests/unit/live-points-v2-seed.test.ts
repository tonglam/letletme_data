import { describe, expect, test } from 'bun:test';

import {
  buildSeedHead,
  buildSeedInput,
  findMissingPickScopes,
  inspectPickScope,
  parseSeedArguments,
  type ExistingPickRow,
  type FinalResultSeedRow,
  type PreviousTotalsRow,
} from '../../scripts/seed-live-points-v2';

function rows(overrides: Partial<ExistingPickRow> = {}): ExistingPickRow[] {
  return Array.from({ length: 15 }, (_, index) => ({
    season_id: 2627,
    entry_id: 6953,
    event_id: 2,
    position: index + 1,
    element_id: index + 1,
    multiplier: index === 0 ? 2 : 1,
    is_captain: index === 0,
    is_vice_captain: index === 1,
    chip: index === 0 ? null : null,
    transfers: index === 0 ? 0 : null,
    transfers_cost: index === 0 ? 0 : null,
    source_created_at: new Date('2026-08-29T10:00:00.000Z'),
    source_updated_at: new Date('2026-08-29T10:01:00.000Z'),
    ...overrides,
  }));
}

describe('Live Points V2 entry-pick seed', () => {
  test('creates a deterministic complete head for exactly 15 valid rows', () => {
    const head = buildSeedHead(rows());
    expect(head).toMatchObject({
      seasonId: 2627,
      entryId: 6953,
      eventId: 2,
      generation: 1,
      rowCount: 15,
      picksBaseRevision: head.contentSha256,
    });
    expect(head.contentSha256).toHaveLength(64);
    expect(head.publicationId).toHaveLength(64);
  });

  test('places malformed rowsets in repair scope instead of making a head', () => {
    const malformed = rows();
    malformed[14] = { ...malformed[14]!, element_id: malformed[0]!.element_id };
    const repair = inspectPickScope(malformed);
    expect(repair).toMatchObject({
      seasonId: 2627,
      entryId: 6953,
      eventId: 2,
      observedRowCount: 15,
    });
    expect(repair?.reasons).toContain('ELEMENTS_NOT_UNIQUE_POSITIVE');
    expect(() => buildSeedHead(malformed)).toThrow('Cannot seed invalid pick scope');
  });

  test('creates repair scope for an eligible entry with no pick rows', () => {
    const missing = findMissingPickScopes(
      [
        { seasonId: 2627, entryId: 6953, eventId: 2 },
        { seasonId: 2627, entryId: 7000, eventId: 2 },
      ],
      [rows()],
    );
    expect(missing).toEqual([
      {
        seasonId: 2627,
        entryId: 7000,
        eventId: 2,
        observedRowCount: 0,
        reasons: ['PICKS_ROWSET_MISSING'],
      },
    ]);
  });

  test('seeds previous totals and final evidence only when the data_checked fence is complete', () => {
    const previous: PreviousTotalsRow = {
      entry_id: 6953,
      through_event_id: 1,
      total_points: 71,
      overall_rank: 123,
    };
    const final: FinalResultSeedRow = {
      entry_id: 6953,
      event_id: 2,
      event_points: 17,
      overall_points: 88,
      event_picks: rows().map((row) => ({
        element: row.element_id,
        position: row.position,
        multiplier: row.multiplier,
        is_captain: row.is_captain,
        is_vice_captain: row.is_vice_captain,
      })),
      automatic_substitutions: [],
      rich_synced_at: new Date('2026-08-29T10:05:00.000Z'),
      data_checked_at: new Date('2026-08-29T10:04:00.000Z'),
    };
    const seeded = buildSeedInput('2627', rows(), previous, final);
    expect(seeded.input.previousTotals).toMatchObject({
      throughEventId: 1,
      totalPoints: 71,
      overallRank: 123,
    });
    expect(seeded.input.finalResult).toMatchObject({
      score: { eventPoints: 17, totalPoints: 88 },
      automaticSubs: [],
    });
    expect(seeded.sourceCheckedAt.toISOString()).toBe('2026-08-29T10:05:00.000Z');

    const stale = buildSeedInput('2627', rows(), previous, {
      ...final,
      rich_synced_at: new Date('2026-08-29T10:03:00.000Z'),
    });
    expect(stale.input.finalResult).toBeNull();
  });

  test('requires explicit scope arguments and rejects duplicate switches', () => {
    expect(parseSeedArguments(['--execute', '--season', '2627', '--event-id', '2'])).toEqual({
      execute: true,
      seedCache: false,
      allFinalized: false,
      season: '2627',
      eventId: 2,
    });
    expect(parseSeedArguments(['--cache', '--season', '2627'])).toEqual({
      execute: false,
      seedCache: true,
      allFinalized: false,
      season: '2627',
      eventId: null,
    });
    expect(
      parseSeedArguments(['--cache', '--all-finalized', '--season', '2627', '--event-id', '2']),
    ).toMatchObject({ allFinalized: true, season: '2627', eventId: 2 });
    expect(() => parseSeedArguments(['--cache'])).toThrow();
    expect(() => parseSeedArguments(['--all-finalized'])).toThrow();
    expect(() => parseSeedArguments(['--season', '2627', '--season', '2627'])).toThrow();
    expect(() => parseSeedArguments(['--event-id', '0'])).toThrow();
  });
});
