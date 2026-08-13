import type { RawFPLLeagueH2HMatch, RawFPLLeagueStandingsResult } from '../clients/fpl';
import { fplClient } from '../clients/fpl';
import type {
  DbTournamentBattleGroupResultInsert,
  DbTournamentGroup,
  DbTournamentGroupInsert,
  DbTournamentKnockoutInsert,
  DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { TournamentSyncContext } from '../domain/tournament';
import { isOfficialH2HTournament } from '../domain/tournament';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { tournamentGroupRepository } from '../repositories/tournament-groups';
import { tournamentOfficialH2HRepository } from '../repositories/tournament-official-h2h';
import { contentHash } from '../utils/content-hash';
import { ValidationError } from '../utils/errors';
import { logInfo, logWarn } from '../utils/logger';

const MAX_H2H_PAGES = 100;

type OfficialH2HClient = Pick<typeof fplClient, 'getLeagueH2HStandings' | 'getLeagueH2HMatches'>;

export type OfficialH2HSourceSnapshot = {
  standings: RawFPLLeagueStandingsResult[];
  matches: Array<RawFPLLeagueH2HMatch & { sourceOrder: number }>;
};

function nonNegativeInteger(value: number | null | undefined): number {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? Number(value) : 0;
}

function integerOrZero(value: number | null | undefined): number {
  return Number.isInteger(value) ? Number(value) : 0;
}

function matchPoints(match: RawFPLLeagueH2HMatch): { home: number | null; away: number | null } {
  const explicitOutcomeFields = [
    match.entry_1_win,
    match.entry_1_draw,
    match.entry_1_loss,
    match.entry_1_total,
    match.entry_2_win,
    match.entry_2_draw,
    match.entry_2_loss,
    match.entry_2_total,
  ];
  const hasExplicitOutcomeContract = explicitOutcomeFields.some((value) => value !== undefined);
  if (
    typeof match.entry_1_total === 'number' &&
    typeof match.entry_2_total === 'number' &&
    [2, 3].includes(match.entry_1_total + match.entry_2_total)
  ) {
    return { home: match.entry_1_total, away: match.entry_2_total };
  }
  if (
    (match.entry_1_win ?? 0) +
      (match.entry_1_draw ?? 0) +
      (match.entry_1_loss ?? 0) +
      (match.entry_2_win ?? 0) +
      (match.entry_2_draw ?? 0) +
      (match.entry_2_loss ?? 0) >
    0
  ) {
    return {
      home: match.entry_1_win ? 3 : match.entry_1_draw ? 1 : 0,
      away: match.entry_2_win ? 3 : match.entry_2_draw ? 1 : 0,
    };
  }
  if (match.winner !== null) {
    return {
      home: match.winner === match.entry_1_entry ? 3 : 0,
      away: match.winner === match.entry_2_entry ? 3 : 0,
    };
  }
  if (hasExplicitOutcomeContract) return { home: null, away: null };
  if (match.entry_1_points === null || match.entry_2_points === null) {
    return { home: null, away: null };
  }
  if (match.entry_1_points > match.entry_2_points) return { home: 3, away: 0 };
  if (match.entry_1_points < match.entry_2_points) return { home: 0, away: 3 };
  return { home: 1, away: 1 };
}

function serializeTiebreak(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function officialKnockoutName(match: RawFPLLeagueH2HMatch): string | null {
  return match.knockout_name?.trim() || null;
}

function isOfficialKnockoutMatch(match: RawFPLLeagueH2HMatch): boolean {
  return officialKnockoutName(match) !== null || match.is_knockout === true;
}

export async function fetchOfficialH2HSourceSnapshot(
  leagueId: number,
  client: OfficialH2HClient = fplClient,
): Promise<OfficialH2HSourceSnapshot> {
  const standings: RawFPLLeagueStandingsResult[] = [];
  let standingsPage = 1;
  let previousStandingsSignature: string | null = null;
  while (true) {
    const response = await client.getLeagueH2HStandings(leagueId, standingsPage, 1);
    standings.push(...response.standings.results);
    const signature = response.standings.results.map((row) => row.entry).join(',');
    if (
      response.standings.has_next &&
      previousStandingsSignature !== null &&
      signature === previousStandingsSignature
    ) {
      throw new ValidationError(
        'Official H2H standings pagination stopped making progress.',
        'TOURNAMENT_OFFICIAL_H2H_STANDINGS_STALLED',
      );
    }
    previousStandingsSignature = signature;
    if (!response.standings.has_next) break;
    standingsPage += 1;
    if (standingsPage > MAX_H2H_PAGES) {
      throw new ValidationError(
        'Official H2H standings pagination exceeded the safety limit.',
        'TOURNAMENT_OFFICIAL_H2H_STANDINGS_LIMIT',
      );
    }
  }

  const matches: Array<RawFPLLeagueH2HMatch & { sourceOrder: number }> = [];
  let matchPage = 1;
  let previousMatchSignature: string | null = null;
  while (true) {
    const response = await client.getLeagueH2HMatches(leagueId, matchPage);
    const signature = response.results.map((match) => match.id).join(',');
    if (
      response.has_next &&
      previousMatchSignature !== null &&
      signature === previousMatchSignature
    ) {
      throw new ValidationError(
        'Official H2H match pagination stopped making progress.',
        'TOURNAMENT_OFFICIAL_H2H_MATCHES_STALLED',
      );
    }
    previousMatchSignature = signature;
    for (const match of response.results) {
      matches.push({ ...match, sourceOrder: matches.length });
    }
    if (!response.has_next) break;
    matchPage += 1;
    if (matchPage > MAX_H2H_PAGES) {
      throw new ValidationError(
        'Official H2H match pagination exceeded the safety limit.',
        'TOURNAMENT_OFFICIAL_H2H_MATCHES_LIMIT',
      );
    }
  }

  const matchIds = new Set<number>();
  for (const match of matches) {
    if (matchIds.has(match.id)) {
      throw new ValidationError(
        `Official H2H response repeated match ${match.id}.`,
        'TOURNAMENT_OFFICIAL_H2H_MATCH_DUPLICATE',
      );
    }
    matchIds.add(match.id);
  }
  const standingEntryIds = new Set<number>();
  for (const standing of standings) {
    if (standingEntryIds.has(standing.entry)) {
      throw new ValidationError(
        `Official H2H standings repeated entry ${standing.entry}.`,
        'TOURNAMENT_OFFICIAL_H2H_STANDINGS_DUPLICATE',
      );
    }
    standingEntryIds.add(standing.entry);
  }
  return { standings, matches };
}

export function projectOfficialH2HStandings(
  currentGroups: readonly DbTournamentGroup[],
  standings: readonly RawFPLLeagueStandingsResult[],
  totalsByEntry?: ReadonlyMap<number, { totalPoints: number; totalTransfersCost: number }>,
): DbTournamentGroupInsert[] {
  const standingsByEntry = new Map(standings.map((standing) => [standing.entry, standing]));
  return currentGroups.map((group) => {
    const standing = standingsByEntry.get(group.entryId);
    const { id: _id, seasonId: _seasonId, sourceGroupRowId: _sourceGroupRowId, ...stored } = group;
    if (!standing) return stored;
    const totals = totalsByEntry?.get(group.entryId);
    return {
      ...stored,
      groupPoints: nonNegativeInteger(standing.total ?? standing.points_total),
      groupRank: standing.rank ?? null,
      played: nonNegativeInteger(standing.matches_played),
      won: nonNegativeInteger(standing.matches_won),
      drawn: nonNegativeInteger(standing.matches_drawn),
      lost: nonNegativeInteger(standing.matches_lost),
      totalPoints: totalsByEntry === undefined ? stored.totalPoints : (totals?.totalPoints ?? 0),
      totalTransfersCost:
        totalsByEntry === undefined ? stored.totalTransfersCost : (totals?.totalTransfersCost ?? 0),
      totalNetPoints: integerOrZero(standing.points_for),
    };
  });
}

function assertMatchSides(match: RawFPLLeagueH2HMatch, entryIds: ReadonlySet<number>): void {
  if (
    !isOfficialKnockoutMatch(match) &&
    match.entry_1_entry === null &&
    match.entry_2_entry === null
  ) {
    throw new ValidationError(
      `Official H2H regular match ${match.id} has no real side.`,
      'TOURNAMENT_OFFICIAL_H2H_MATCH_INVALID',
    );
  }
  if (
    match.entry_1_entry !== null &&
    match.entry_2_entry !== null &&
    match.entry_1_entry === match.entry_2_entry
  ) {
    throw new ValidationError(
      `Official H2H match ${match.id} repeats the same entry.`,
      'TOURNAMENT_OFFICIAL_H2H_MATCH_INVALID',
    );
  }
  for (const entryId of [match.entry_1_entry, match.entry_2_entry, match.winner]) {
    if (entryId !== null && !entryIds.has(entryId)) {
      throw new ValidationError(
        `Official H2H match ${match.id} references entry ${entryId} outside the roster.`,
        'TOURNAMENT_OFFICIAL_H2H_ROSTER_MISMATCH',
      );
    }
  }
  if (
    match.winner !== null &&
    match.winner !== match.entry_1_entry &&
    match.winner !== match.entry_2_entry
  ) {
    throw new ValidationError(
      `Official H2H match ${match.id} has a winner outside its sides.`,
      'TOURNAMENT_OFFICIAL_H2H_MATCH_INVALID',
    );
  }
}

export function validateOfficialH2HSchedule(
  tournament: TournamentSyncContext,
  entryIds: ReadonlySet<number>,
  snapshot: OfficialH2HSourceSnapshot,
): void {
  if (snapshot.matches.length === 0) return;

  for (const match of snapshot.matches) assertMatchSides(match, entryIds);
  const regularMatches = snapshot.matches.filter((match) => !isOfficialKnockoutMatch(match));
  const startEventId = tournament.groupStartedEventId;
  const endEventId = tournament.groupEndedEventId;
  if (startEventId === null || endEventId === null || regularMatches.length === 0) {
    throw new ValidationError(
      'Official H2H response does not contain a complete regular schedule.',
      'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INCOMPLETE',
    );
  }

  const byEvent = new Map<number, RawFPLLeagueH2HMatch[]>();
  for (const match of regularMatches) {
    if (match.event < startEventId || match.event > endEventId) {
      throw new ValidationError(
        `Official H2H regular match ${match.id} falls outside the group window.`,
        'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INVALID',
      );
    }
    const eventMatches = byEvent.get(match.event) ?? [];
    eventMatches.push(match);
    byEvent.set(match.event, eventMatches);
  }

  const expectedMatchesPerEvent = Math.ceil(entryIds.size / 2);
  const expectedAverageSides = entryIds.size % 2;
  for (let eventId = startEventId; eventId <= endEventId; eventId += 1) {
    const eventMatches = byEvent.get(eventId) ?? [];
    if (eventMatches.length !== expectedMatchesPerEvent) {
      throw new ValidationError(
        `Official H2H GW${eventId} has ${eventMatches.length} of ${expectedMatchesPerEvent} matches.`,
        'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INCOMPLETE',
      );
    }
    const seenEntries = new Set<number>();
    let averageSides = 0;
    for (const match of eventMatches) {
      for (const entryId of [match.entry_1_entry, match.entry_2_entry]) {
        if (entryId === null) {
          averageSides += 1;
          continue;
        }
        if (seenEntries.has(entryId)) {
          throw new ValidationError(
            `Official H2H GW${eventId} repeats entry ${entryId}.`,
            'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INVALID',
          );
        }
        seenEntries.add(entryId);
      }
    }
    if (seenEntries.size !== entryIds.size || averageSides !== expectedAverageSides) {
      throw new ValidationError(
        `Official H2H GW${eventId} does not cover the roster exactly once.`,
        'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INCOMPLETE',
      );
    }
  }
}

function resolveKnockoutRound(
  tournament: TournamentSyncContext,
  match: RawFPLLeagueH2HMatch,
): number {
  const rounds = tournament.knockoutEventNum ?? 0;
  const normalizedName = match.knockout_name?.trim().toLowerCase() ?? '';
  if (normalizedName.includes('quarter')) return Math.max(1, rounds - 2);
  if (normalizedName.includes('semi')) return Math.max(1, rounds - 1);
  if (normalizedName.includes('final')) return Math.max(1, rounds);
  const start = tournament.knockoutStartedEventId ?? match.event;
  return Math.min(Math.max(match.event - start + 1, 1), Math.max(rounds, 1));
}

export function buildOfficialH2HRows(
  tournament: TournamentSyncContext,
  entryIds: ReadonlySet<number>,
  snapshot: OfficialH2HSourceSnapshot,
  checkedAt: Date,
): {
  scheduleHash: string;
  battleRows: DbTournamentBattleGroupResultInsert[];
  knockoutRows: DbTournamentKnockoutResultInsert[];
  bracketRows: DbTournamentKnockoutInsert[];
} {
  const battleRows: DbTournamentBattleGroupResultInsert[] = [];
  const knockoutRows: DbTournamentKnockoutResultInsert[] = [];
  validateOfficialH2HSchedule(tournament, entryIds, snapshot);
  const knockoutMatches = snapshot.matches.filter(isOfficialKnockoutMatch);
  const roundMatchCounts = new Map<number, number>();
  const knockoutByLocalMatchId = new Map<number, RawFPLLeagueH2HMatch>();
  const configuredRounds = tournament.knockoutEventNum ?? 0;
  const configuredTeamCount = tournament.knockoutTeamNum ?? 0;

  for (const match of snapshot.matches) {
    const points = matchPoints(match);
    const knockoutName = officialKnockoutName(match);
    if (!isOfficialKnockoutMatch(match)) {
      battleRows.push({
        tournamentId: tournament.id,
        groupId: 1,
        eventId: match.event,
        homeIndex: match.sourceOrder * 2 + 1,
        homeEntryId: match.entry_1_entry,
        homeNetPoints: match.entry_1_points,
        homeRank: null,
        homeMatchPoints: points.home,
        awayIndex: match.sourceOrder * 2 + 2,
        awayEntryId: match.entry_2_entry,
        awayNetPoints: match.entry_2_points,
        awayRank: null,
        awayMatchPoints: points.away,
        officialMatchId: match.id,
        sourceOrder: match.sourceOrder,
        homeIsAverage: match.entry_1_entry === null,
        awayIsAverage: match.entry_2_entry === null,
        isBye: match.is_bye ?? false,
        sourceCheckedAt: checkedAt,
      });
      continue;
    }

    const round = resolveKnockoutRound(tournament, match);
    const roundIndex = roundMatchCounts.get(round) ?? 0;
    const expectedMatches = configuredTeamCount > 0 ? configuredTeamCount / 2 ** round : 0;
    if (configuredRounds < 1 || expectedMatches < 1 || roundIndex >= expectedMatches) {
      throw new ValidationError(
        `Official H2H knockout match ${match.id} does not fit the configured bracket.`,
        'TOURNAMENT_OFFICIAL_H2H_KNOCKOUT_INVALID',
      );
    }
    const roundStart = configuredTeamCount - configuredTeamCount / 2 ** (round - 1) + 1;
    const localMatchId = roundStart + roundIndex;
    roundMatchCounts.set(round, roundIndex + 1);
    knockoutByLocalMatchId.set(localMatchId, match);
    knockoutRows.push({
      tournamentId: tournament.id,
      eventId: match.event,
      matchId: localMatchId,
      playAgainstId: 1,
      homeEntryId: match.entry_1_entry,
      homeNetPoints: match.entry_1_points,
      awayEntryId: match.entry_2_entry,
      awayNetPoints: match.entry_2_points,
      matchWinner: match.winner,
      officialMatchId: match.id,
      sourceOrder: match.sourceOrder,
      knockoutName,
      tiebreak: serializeTiebreak(match.tiebreak),
      sourceCheckedAt: checkedAt,
    });
  }

  const bracketRows: DbTournamentKnockoutInsert[] = [];
  if (knockoutMatches.length > 0 && configuredRounds > 0 && configuredTeamCount > 1) {
    let matchId = 1;
    for (let round = 1; round <= configuredRounds; round += 1) {
      const matchesInRound = configuredTeamCount / 2 ** round;
      const nextRoundStart = round < configuredRounds ? matchId + matchesInRound : null;
      for (let index = 0; index < matchesInRound; index += 1) {
        const localMatchId = matchId + index;
        const source = knockoutByLocalMatchId.get(localMatchId);
        const homeWon = Boolean(
          source && source.winner !== null && source.winner === source.entry_1_entry,
        );
        const awayWon = Boolean(
          source && source.winner !== null && source.winner === source.entry_2_entry,
        );
        bracketRows.push({
          tournamentId: tournament.id,
          round,
          startedEventId: source?.event ?? (tournament.knockoutStartedEventId ?? 1) + round - 1,
          endedEventId: source?.event ?? (tournament.knockoutStartedEventId ?? 1) + round - 1,
          matchId: localMatchId,
          nextMatchId: nextRoundStart === null ? null : nextRoundStart + Math.floor(index / 2),
          homeEntryId: source?.entry_1_entry ?? null,
          homeNetPoints: source?.entry_1_points ?? null,
          homeWins: homeWon ? 1 : 0,
          awayEntryId: source?.entry_2_entry ?? null,
          awayNetPoints: source?.entry_2_points ?? null,
          awayWins: awayWon ? 1 : 0,
          roundWinner: source?.winner ?? null,
        });
      }
      matchId += matchesInRound;
    }
  }

  const scheduleHash = contentHash(
    snapshot.matches
      .filter((match) => !isOfficialKnockoutMatch(match))
      .map((match) => ({
        officialMatchId: match.id,
        eventId: match.event,
        sourceOrder: match.sourceOrder,
        homeEntryId: match.entry_1_entry,
        awayEntryId: match.entry_2_entry,
        isBye: match.is_bye ?? false,
      })),
  );
  return { scheduleHash, battleRows, knockoutRows, bracketRows };
}

export async function syncOfficialH2HTournament(
  season: FplSeasonRef,
  tournament: TournamentSyncContext,
  reconcileEventId?: number,
): Promise<{ updatedGroups: number; updatedResults: number; skipped: number }> {
  if (!isOfficialH2HTournament(tournament) || !tournament.leagueId) {
    throw new ValidationError(
      'Tournament is not an official H2H mirror.',
      'TOURNAMENT_OFFICIAL_H2H_REQUIRED',
    );
  }

  const [snapshot, entryIds] = await Promise.all([
    fetchOfficialH2HSourceSnapshot(tournament.leagueId),
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournament.id),
  ]);
  const entryIdSet = new Set(entryIds);
  if (snapshot.standings.length > 0 && snapshot.standings.length !== entryIdSet.size) {
    throw new ValidationError(
      'Official H2H standings do not cover the complete roster.',
      'TOURNAMENT_OFFICIAL_H2H_STANDINGS_INCOMPLETE',
    );
  }
  for (const standing of snapshot.standings) {
    if (!entryIdSet.has(standing.entry)) {
      throw new ValidationError(
        `Official H2H standings reference entry ${standing.entry} outside the roster.`,
        'TOURNAMENT_OFFICIAL_H2H_ROSTER_MISMATCH',
      );
    }
  }

  const currentGroups = await tournamentGroupRepository.findByTournamentAndEntries(
    season,
    tournament.id,
    entryIds,
  );
  if (
    currentGroups.length !== entryIdSet.size ||
    currentGroups.some((group) => !entryIdSet.has(group.entryId))
  ) {
    throw new ValidationError(
      'Official H2H tournament group does not match its roster.',
      'TOURNAMENT_OFFICIAL_H2H_GROUP_MISMATCH',
    );
  }
  if (reconcileEventId) {
    const localResults = await entryEventResultsRepository.findByEventAndEntryIds(
      season,
      reconcileEventId,
      entryIds,
    );
    const localByEntry = new Map(localResults.map((result) => [result.entryId, result]));
    for (const match of snapshot.matches.filter(
      (candidate) => candidate.event === reconcileEventId,
    )) {
      for (const [entryId, officialPoints] of [
        [match.entry_1_entry, match.entry_1_points],
        [match.entry_2_entry, match.entry_2_points],
      ] as const) {
        if (entryId === null || officialPoints === null) continue;
        const local = localByEntry.get(entryId);
        if (local && local.eventNetPoints !== officialPoints) {
          logWarn('Official H2H score differs from local entry event result', {
            tournamentId: tournament.id,
            eventId: reconcileEventId,
            officialMatchId: match.id,
            entryId,
            officialPoints,
            localPoints: local.eventNetPoints,
          });
        }
      }
    }
  }
  const checkedAt = new Date();
  const officialRows = buildOfficialH2HRows(tournament, entryIdSet, snapshot, checkedAt);
  const aggregateTotals = await entryEventResultsRepository.aggregateTotalsByEntry(
    season,
    entryIds,
    tournament.groupStartedEventId ?? 1,
    tournament.groupEndedEventId ?? reconcileEventId ?? 38,
  );
  const totalsByEntry = new Map(aggregateTotals.map((row) => [row.entryId, row] as const));
  const groupRows = projectOfficialH2HStandings(currentGroups, snapshot.standings, totalsByEntry);
  const published = await tournamentOfficialH2HRepository.publish(season, tournament.id, {
    ...officialRows,
    checkedAt,
    lockSchedule: snapshot.matches.some((match) => !isOfficialKnockoutMatch(match)),
    groupRows,
  });

  logInfo('Official H2H strategy completed', {
    tournamentId: tournament.id,
    leagueId: tournament.leagueId,
    standings: snapshot.standings.length,
    matches: snapshot.matches.length,
  });
  return {
    updatedGroups: published.groupRows,
    updatedResults: published.battleRows + published.knockoutRows,
    skipped: 0,
  };
}

export const OfficialH2HStrategy = {
  sync: syncOfficialH2HTournament,
};
