import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { createTournament } from '../../src/services/tournament-create.service';
import { fetchLeagueParticipants } from '../../src/services/tournament-league-members.service';
import { ValidationError } from '../../src/utils/errors';
import { logger } from '../../src/utils/logger';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('tournament league membership import', () => {
  test('combines ranked standings with every preseason new-entry page', async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mock(async (request: string | URL | Request) => {
      const url = new URL(String(request));
      requestedUrls.push(url.toString());
      const newEntriesPage = Number(url.searchParams.get('page_new_entries'));
      const payload = {
        league: { id: 8863, name: 'Classic League', start_event: 1, scoring: 'c' },
        standings: {
          page: 1,
          has_next: false,
          results: [
            {
              entry: 100,
              entry_name: 'Ranked Team',
              player_name: 'Ranked Manager',
              rank: 1,
              total: 100,
            },
          ],
        },
        new_entries: {
          page: newEntriesPage,
          has_next: newEntriesPage === 1,
          results: [
            {
              entry: 200 + newEntriesPage,
              entry_name: `New Team ${newEntriesPage}`,
              player_first_name: 'New',
              player_last_name: `Manager ${newEntriesPage}`,
            },
            ...(newEntriesPage === 1
              ? [
                  {
                    entry: 100,
                    entry_name: 'Unranked duplicate',
                    player_first_name: 'Duplicate',
                    player_last_name: 'Manager',
                  },
                ]
              : []),
          ],
        },
      };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchLeagueParticipants(
      'https://fantasy.premierleague.com/en/leagues/8863/standings/c',
    );

    expect(result.leagueId).toBe(8863);
    expect(result.leagueType).toBe('classic');
    expect(result.participants.map((participant) => participant.id)).toEqual(['100', '201', '202']);
    expect(result.participants.find((participant) => participant.id === '100')).toMatchObject({
      team: 'Ranked Team',
      overallRank: 1,
      totalPoints: 100,
    });
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toContain('page_new_entries=2');
  });

  test('rejects an empty authoritative league', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            league: { id: 8863, name: 'Empty League', start_event: 1, scoring: 'c' },
            standings: { page: 1, has_next: false, results: [] },
            new_entries: { page: 1, has_next: false, results: [] },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    await expect(
      fetchLeagueParticipants('https://fantasy.premierleague.com/leagues/8863/standings/c'),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_LEAGUE_EMPTY' });
  });

  test('enforces the complete-roster 100-page safety bound', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          league: { id: 8863, name: 'Huge League', start_event: 1, scoring: 'c' },
          standings: {
            page: calls,
            has_next: true,
            results: [
              {
                entry: calls,
                entry_name: `Team ${calls}`,
                player_name: `Manager ${calls}`,
                rank: calls,
                total: 0,
              },
            ],
          },
          new_entries: { page: calls, has_next: false, results: [] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      fetchLeagueParticipants('https://fantasy.premierleague.com/leagues/8863/standings/c'),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toBe(100);
  });

  test('emits one privacy-bounded creation report for a rejected attempt', async () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const privateMarker = 'Private Manager Marker';
    try {
      await expect(
        createTournament({
          tournamentName: 'Rejected creation fixture',
          adminId: '123456',
          creator: privateMarker,
          participantSource: 'official',
          leagueUrl: 'https://example.com/private-league-url',
          groupFormat: 'points',
          startGameweek: 'GW1',
          endGameweek: 'GW38',
          groupNum: '1',
          qualifiersPerGroup: '',
          knockoutFormat: 'none',
        }),
      ).rejects.toBeInstanceOf(ValidationError);

      const reports = infoSpy.mock.calls
        .map(([payload]) => payload as unknown as Record<string, unknown>)
        .filter((payload) => payload.event === 'tournament_creation');
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ outcome: 'rejected', tournamentId: null });
      const serialized = JSON.stringify(reports[0]);
      expect(serialized).not.toContain(privateMarker);
      expect(serialized).not.toContain('private-league-url');
      expect(serialized).not.toContain('123456');
    } finally {
      infoSpy.mockRestore();
    }
  });
});
