import { afterEach, describe, expect, mock, test } from 'bun:test';

import { fetchLeagueParticipants } from '../../src/services/tournament-league-members.service';

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
});
