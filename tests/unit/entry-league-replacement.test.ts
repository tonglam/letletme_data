import { describe, expect, it, mock } from 'bun:test';

import { createEntryLeagueInfoRepository } from '../../src/repositories/entry-league-infos';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

function createFakeDatabase(removedRows: Array<{ leagueId: number }> = []) {
  const returning = mock(async () => removedRows);
  const where = mock((_condition: unknown) => ({ returning }));
  const deleteRows = mock((_table: unknown) => ({ where }));
  const onConflictDoUpdate = mock(async (_config: unknown) => undefined);
  const values = mock((_rows: unknown) => ({ onConflictDoUpdate }));
  const insert = mock((_table: unknown) => ({ values }));

  return {
    db: { delete: deleteRows, insert },
    deleteRows,
    insert,
    onConflictDoUpdate,
    returning,
    values,
    where,
  };
}

describe('entry league snapshot replacement', () => {
  it('retains stored rows when the upstream leagues field is missing', async () => {
    const fake = createFakeDatabase();
    const repository = createEntryLeagueInfoRepository(fake.db as never);

    await repository.upsertFromLeagues(TEST_SEASON, 42, undefined);

    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.deleteRows).not.toHaveBeenCalled();
  });

  it('deletes the complete stored snapshot when the upstream list is explicitly empty', async () => {
    const fake = createFakeDatabase([{ leagueId: 7 }, { leagueId: 8 }]);
    const repository = createEntryLeagueInfoRepository(fake.db as never);

    await repository.upsertFromLeagues(TEST_SEASON, 42, { classic: [], h2h: [] });

    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.deleteRows).toHaveBeenCalledTimes(1);
    expect(fake.where).toHaveBeenCalledTimes(1);
    expect(fake.returning).toHaveBeenCalledTimes(1);
  });

  it('upserts current rows and retires absent rows without conflating league types', async () => {
    const fake = createFakeDatabase([{ leagueId: 99 }]);
    const repository = createEntryLeagueInfoRepository(fake.db as never);

    await repository.upsertFromLeagues(TEST_SEASON, 42, {
      classic: [
        {
          id: 7,
          name: 'Renamed Classic',
          league_type: 'x',
          short_name: null,
          entry_rank: 3,
          entry_last_rank: 5,
          start_event: 1,
        },
      ],
      h2h: [
        {
          id: 7,
          name: 'Same ID H2H',
          league_type: 'x',
          short_name: null,
          entry_rank: null,
          entry_last_rank: null,
          start_event: 2,
        },
      ],
    });

    expect(fake.values).toHaveBeenCalledTimes(1);
    expect(fake.values.mock.calls[0]?.[0]).toEqual([
      {
        seasonId: TEST_SEASON.seasonId,
        entryId: 42,
        leagueId: 7,
        leagueName: 'Renamed Classic',
        leagueType: 'classic',
        officialKind: 'x',
        shortName: null,
        startedEvent: 1,
        entryRank: 3,
        entryLastRank: 5,
      },
      {
        seasonId: TEST_SEASON.seasonId,
        entryId: 42,
        leagueId: 7,
        leagueName: 'Same ID H2H',
        leagueType: 'h2h',
        officialKind: 'x',
        shortName: null,
        startedEvent: 2,
        entryRank: null,
        entryLastRank: null,
      },
    ]);
    expect(fake.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(fake.deleteRows).toHaveBeenCalledTimes(1);
  });

  it('stores FPL system short_name and official kind without conflating scoring type', async () => {
    const fake = createFakeDatabase();
    const repository = createEntryLeagueInfoRepository(fake.db as never);

    await repository.upsertFromLeagues(TEST_SEASON, 42, {
      classic: [
        {
          id: 314,
          name: 'Overall',
          league_type: 's',
          short_name: 'overall',
          entry_rank: 12_580,
          entry_last_rank: 12_600,
          start_event: 1,
        },
        {
          id: 317,
          name: 'Sky Sports League',
          league_type: 's',
          short_name: 'brd-skysports',
          entry_rank: 80,
          entry_last_rank: 90,
          start_event: 1,
        },
        {
          id: 318,
          name: 'Legacy Category League',
          league_type: 'c',
          short_name: null,
          entry_rank: 81,
          entry_last_rank: 92,
          start_event: 1,
        },
      ],
      h2h: [],
    });

    expect(fake.values.mock.calls[0]?.[0]).toEqual([
      {
        seasonId: TEST_SEASON.seasonId,
        entryId: 42,
        leagueId: 314,
        leagueName: 'Overall',
        leagueType: 'classic',
        officialKind: 's',
        shortName: 'overall',
        startedEvent: 1,
        entryRank: 12_580,
        entryLastRank: 12_600,
      },
      {
        seasonId: TEST_SEASON.seasonId,
        entryId: 42,
        leagueId: 317,
        leagueName: 'Sky Sports League',
        leagueType: 'classic',
        officialKind: 's',
        shortName: 'brd-skysports',
        startedEvent: 1,
        entryRank: 80,
        entryLastRank: 90,
      },
      {
        seasonId: TEST_SEASON.seasonId,
        entryId: 42,
        leagueId: 318,
        leagueName: 'Legacy Category League',
        leagueType: 'classic',
        officialKind: null,
        shortName: null,
        startedEvent: 1,
        entryRank: 81,
        entryLastRank: 92,
      },
    ]);
  });
});
