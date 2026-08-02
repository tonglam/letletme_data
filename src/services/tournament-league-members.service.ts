import { fplClient } from '../clients/fpl';
import {
  mapStandingsResultToParticipant,
  parseLeagueUrl,
  type LeagueType,
  type TournamentParticipant,
} from '../domain/tournament';
import { ValidationError } from '../utils/errors';

const MAX_LEAGUE_PAGES = 100;

export async function fetchLeagueParticipants(leagueUrl: string): Promise<{
  leagueId: number;
  leagueType: LeagueType;
  participants: TournamentParticipant[];
}> {
  const { leagueId, leagueType } = parseLeagueUrl(leagueUrl);
  const participantMap = new Map<string, TournamentParticipant>();
  let standingsPage = 1;
  let newEntriesPage = 1;
  let readStandings = true;
  let readNewEntries = true;

  while (readStandings || readNewEntries) {
    const response =
      leagueType === 'h2h'
        ? await fplClient.getLeagueH2HStandings(leagueId, standingsPage, newEntriesPage)
        : await fplClient.getLeagueClassicStandings(leagueId, standingsPage, newEntriesPage);

    // Ranked standings are authoritative if an entry briefly appears in both
    // cursors because they carry current rank and points.
    for (const rawResult of readStandings ? response.standings.results : []) {
      const participant = mapStandingsResultToParticipant(rawResult);
      if (participant) participantMap.set(participant.id, participant);
    }

    for (const rawResult of readNewEntries ? (response.new_entries?.results ?? []) : []) {
      const participant = mapStandingsResultToParticipant(rawResult);
      if (participant && !participantMap.has(participant.id)) {
        participantMap.set(participant.id, participant);
      }
    }

    const standingsHasNext: boolean = readStandings && response.standings.has_next;
    const newEntriesHasNext: boolean = readNewEntries && response.new_entries?.has_next === true;
    if (standingsHasNext) standingsPage += 1;
    if (newEntriesHasNext) newEntriesPage += 1;
    readStandings = standingsHasNext;
    readNewEntries = newEntriesHasNext;

    if (standingsPage > MAX_LEAGUE_PAGES || newEntriesPage > MAX_LEAGUE_PAGES) {
      throw new ValidationError(
        'League membership pagination exceeded the safety limit.',
        'TOURNAMENT_LEAGUE_PAGINATION_LIMIT',
      );
    }
  }

  const participants = Array.from(participantMap.values());
  if (participants.length === 0) {
    throw new ValidationError(
      'No participants were found for that league.',
      'TOURNAMENT_LEAGUE_EMPTY',
    );
  }

  return { leagueId, leagueType, participants };
}
