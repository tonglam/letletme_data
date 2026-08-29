import { describe, expect, test } from 'bun:test';

import {
  buildSeedHead,
  inspectPickScope,
  parseSeedArguments,
  type ExistingPickRow,
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

  test('requires explicit scope arguments and rejects duplicate switches', () => {
    expect(parseSeedArguments(['--execute', '--season', '2627', '--event-id', '2'])).toEqual({
      execute: true,
      season: '2627',
      eventId: 2,
    });
    expect(() => parseSeedArguments(['--season', '2627', '--season', '2627'])).toThrow();
    expect(() => parseSeedArguments(['--event-id', '0'])).toThrow();
  });
});
