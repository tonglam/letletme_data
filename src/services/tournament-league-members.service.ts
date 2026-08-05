import { fplClient } from '../clients/fpl';
import {
  mapStandingsResultToParticipant,
  parseLeagueUrl,
  type LeagueType,
  type TournamentParticipant,
} from '../domain/tournament';
import { ValidationError } from '../utils/errors';

const MAX_LEAGUE_PAGES = 100;

type LeagueMembersClient = Pick<
  typeof fplClient,
  'getLeagueClassicStandings' | 'getLeagueH2HStandings'
>;

export async function fetchLeagueParticipantsById(
  leagueId: number,
  leagueType: LeagueType,
  client: LeagueMembersClient = fplClient,
): Promise<{
  leagueId: number;
  leagueType: LeagueType;
  leagueName: string | null;
  participants: TournamentParticipant[];
}> {
  const participantMap = new Map<string, TournamentParticipant>();
  let standingsPage = 1;
  let newEntriesPage = 1;
  let readStandings = true;
  let readNewEntries = true;
  let leagueName: string | null = null;
  let previousStandingsSignature: string | null = null;
  let previousNewEntriesSignature: string | null = null;

  while (readStandings || readNewEntries) {
    const response =
      leagueType === 'h2h'
        ? await client.getLeagueH2HStandings(leagueId, standingsPage, newEntriesPage)
        : await client.getLeagueClassicStandings(leagueId, standingsPage, newEntriesPage);

    leagueName ??= response.league?.name?.trim() || null;

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
    const standingsSignature = readStandings
      ? response.standings.results.map((entry) => entry.entry).join(',')
      : null;
    const newEntriesSignature = readNewEntries
      ? (response.new_entries?.results ?? []).map((entry) => entry.entry).join(',')
      : null;
    const standingsStalled =
      standingsHasNext &&
      previousStandingsSignature !== null &&
      standingsSignature === previousStandingsSignature;
    const newEntriesStalled =
      newEntriesHasNext &&
      previousNewEntriesSignature !== null &&
      newEntriesSignature === previousNewEntriesSignature;
    if (standingsStalled || newEntriesStalled) {
      throw new ValidationError(
        'League membership pagination stopped making progress.',
        'TOURNAMENT_LEAGUE_PAGINATION_STALLED',
      );
    }
    if (readStandings) previousStandingsSignature = standingsSignature;
    if (readNewEntries) previousNewEntriesSignature = newEntriesSignature;
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

  return { leagueId, leagueType, leagueName, participants };
}

export async function fetchLeagueParticipants(leagueUrl: string): Promise<{
  leagueId: number;
  leagueType: LeagueType;
  leagueName: string | null;
  participants: TournamentParticipant[];
}> {
  const { leagueId, leagueType } = parseLeagueUrl(leagueUrl);
  return fetchLeagueParticipantsById(leagueId, leagueType);
}
