import { describe, expect, test } from 'bun:test';

import { isRetryableTournamentTrendPublicationConflict } from '../../src/services/tournament-trends-publication.service';

describe('tournament Trends publication retries', () => {
  test('retries serialization failures from concurrent source writes', () => {
    expect(isRetryableTournamentTrendPublicationConflict({ code: '40001' })).toBe(true);
    expect(
      isRetryableTournamentTrendPublicationConflict({
        cause: { code: '40001' },
      }),
    ).toBe(true);
  });

  test('only retries the owned scope revision unique conflict', () => {
    expect(
      isRetryableTournamentTrendPublicationConflict({
        code: '23505',
        constraint: 'tournament_selection_stat_publications_scope_revision_unique',
      }),
    ).toBe(true);
    expect(
      isRetryableTournamentTrendPublicationConflict({
        code: '23505',
        constraint: 'another_unique_constraint',
      }),
    ).toBe(false);
    expect(isRetryableTournamentTrendPublicationConflict({ code: '42P01' })).toBe(false);
  });
});
