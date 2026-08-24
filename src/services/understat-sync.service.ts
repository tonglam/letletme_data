import type {
  UnderstatMatch,
  UnderstatPlayerMatchStat,
  UnderstatPlayerSeason,
  UnderstatPlayerTeamSeason,
  UnderstatSeason,
  UnderstatSyncMode,
  UnderstatTeam,
  UnderstatTeamMatchStat,
  UnderstatTeamSeason,
  UnderstatTeamStatSplit,
} from '../domain/understat';
import { UNDERSTAT_SPLIT_DIMENSIONS, sourceYearFromSeason } from '../domain/understat';
import { getConfig } from '../utils/config';

const LEAGUE_CARDINALITY: Readonly<Record<string, { teams: number; matches: number }>> = {
  EPL: { teams: 20, matches: 380 },
};

export interface UnderstatCompletenessResult {
  complete: boolean;
  reason: string;
}

export class IncompleteUnderstatResourceError extends Error {
  constructor(resource: string, reason: string) {
    super(`Understat ${resource} incomplete: ${reason}`);
    this.name = 'IncompleteUnderstatResourceError';
  }
}

export function assertUnderstatResourceHashes(
  resource: string,
  expectedHashes: readonly string[],
  persistedHashes: readonly string[],
): void {
  const expected = [...expectedHashes].sort();
  const persisted = [...persistedHashes].sort();
  if (
    expected.length !== persisted.length ||
    expected.some((sourceHash, index) => sourceHash !== persisted[index])
  ) {
    throw new Error(
      `Understat ${resource} post-commit verification failed: expected=${expected.length} persisted=${persisted.length}`,
    );
  }
}

/** Verify that every incoming resource hash survived an additive active write. */
export function assertUnderstatResourceHashesIncluded(
  resource: string,
  expectedHashes: readonly string[],
  persistedHashes: readonly string[],
): void {
  const expectedCounts = new Map<string, number>();
  for (const hash of expectedHashes) {
    expectedCounts.set(hash, (expectedCounts.get(hash) ?? 0) + 1);
  }
  const persistedCounts = new Map<string, number>();
  for (const hash of persistedHashes) {
    persistedCounts.set(hash, (persistedCounts.get(hash) ?? 0) + 1);
  }
  for (const [hash, count] of expectedCounts) {
    if ((persistedCounts.get(hash) ?? 0) < count) {
      throw new Error(
        `Understat ${resource} post-commit verification failed: expected hash missing (${hash})`,
      );
    }
  }
}

function incomplete(reason: string): UnderstatCompletenessResult {
  return { complete: false, reason };
}

function complete(): UnderstatCompletenessResult {
  return { complete: true, reason: 'complete' };
}

export function evaluateUnderstatPlayerDiscoveryCompleteness(
  incomingPlayerIds: readonly number[],
  previousPlayerIds: Iterable<number>,
  allowMissing = false,
): UnderstatCompletenessResult {
  const incoming = new Set(incomingPlayerIds);
  if (incoming.size !== incomingPlayerIds.length) {
    return incomplete('player summaries contain duplicate player IDs');
  }
  if (incoming.size === 0) return incomplete('player summaries are empty');

  const previous = new Set(previousPlayerIds);
  const missing = [...previous].filter((playerId) => !incoming.has(playerId));
  if (!allowMissing && missing.length > 0) {
    return incomplete(
      `player summaries shrank ${incoming.size}/${previous.size}; missing=${missing.join(',')}`,
    );
  }
  return complete();
}

export function expectedUnderstatPlayerIdsForTeam(
  teamId: number,
  discovery: {
    teams: readonly Pick<UnderstatTeam, 'id' | 'title'>[];
    playerSeasons: readonly Pick<UnderstatPlayerSeason, 'playerId' | 'sourceTeamTitle'>[];
  },
): Set<number> {
  const team = discovery.teams.find((candidate) => candidate.id === teamId);
  if (!team) return new Set();
  return new Set(
    discovery.playerSeasons
      .filter((player) => {
        const destinationTitle = player.sourceTeamTitle
          .split(',')
          .map((title) => title.trim())
          .filter((title) => title.length > 0)
          .at(-1);
        return destinationTitle === team.title;
      })
      .map((player) => player.playerId),
  );
}

export function evaluateUnderstatTeamResourceCompleteness(
  teamId: number,
  discovery: {
    teams: readonly Pick<UnderstatTeam, 'id'>[];
    matches: readonly Pick<UnderstatMatch, 'id' | 'homeTeamId' | 'awayTeamId' | 'isResult'>[];
    teamMatchStats: readonly Pick<UnderstatTeamMatchStat, 'matchId' | 'teamId' | 'side'>[];
    teamSeasons: readonly Pick<UnderstatTeamSeason, 'teamId'>[];
  },
  splits: readonly Pick<UnderstatTeamStatSplit, 'teamId' | 'dimension'>[],
): UnderstatCompletenessResult {
  if (!discovery.teams.some((team) => team.id === teamId)) {
    return incomplete(`team ${teamId} is missing from league discovery`);
  }
  if (!discovery.teamSeasons.some((team) => team.teamId === teamId)) {
    return incomplete(`team ${teamId} season summary is missing`);
  }

  const dimensions = new Set(
    splits.filter((split) => split.teamId === teamId).map((split) => split.dimension),
  );
  const missingDimensions = UNDERSTAT_SPLIT_DIMENSIONS.filter(
    (dimension) => !dimensions.has(dimension),
  );
  if (missingDimensions.length > 0) {
    return incomplete(`team ${teamId} split dimensions missing: ${missingDimensions.join(',')}`);
  }

  const completedMatches = discovery.matches.filter(
    (match) => match.isResult && (match.homeTeamId === teamId || match.awayTeamId === teamId),
  );
  for (const match of completedMatches) {
    const expectedSide = match.homeTeamId === teamId ? 'h' : 'a';
    const hasStat = discovery.teamMatchStats.some(
      (stat) => stat.matchId === match.id && stat.teamId === teamId && stat.side === expectedSide,
    );
    if (!hasStat) {
      return incomplete(`team ${teamId} completed match ${match.id} stats are missing`);
    }
  }

  return complete();
}

/**
 * Active league discovery may omit one team's completed-match history. Keep
 * that team's prior season aggregate until all of its expected team-stat rows
 * are present, while still persisting complete teams from the same pass.
 */
export function selectCompleteUnderstatTeamSeasonRows(
  matches: readonly Pick<UnderstatMatch, 'id' | 'homeTeamId' | 'awayTeamId' | 'isResult'>[],
  teamMatchRows: readonly Pick<UnderstatTeamMatchStat, 'matchId' | 'teamId' | 'side'>[],
  teamSeasons: readonly UnderstatTeamSeason[],
): UnderstatTeamSeason[] {
  const expectedByTeam = new Map<number, Map<number, 'h' | 'a'>>();
  for (const match of matches) {
    if (!match.isResult) continue;
    expectedByTeam.set(
      match.homeTeamId,
      (expectedByTeam.get(match.homeTeamId) ?? new Map()).set(match.id, 'h'),
    );
    expectedByTeam.set(
      match.awayTeamId,
      (expectedByTeam.get(match.awayTeamId) ?? new Map()).set(match.id, 'a'),
    );
  }
  const completeTeamIds = new Set<number>();
  for (const [teamId, expectedMatches] of expectedByTeam) {
    if (
      [...expectedMatches].every(([matchId, side]) =>
        teamMatchRows.some(
          (row) => row.matchId === matchId && row.teamId === teamId && row.side === side,
        ),
      )
    ) {
      completeTeamIds.add(teamId);
    }
  }
  return teamSeasons.filter(
    (row) => !expectedByTeam.has(row.teamId) || completeTeamIds.has(row.teamId),
  );
}

export function evaluateUnderstatPlayerTeamResourceCompleteness(
  teamId: number,
  discovery: {
    teams: readonly Pick<UnderstatTeam, 'id' | 'title'>[];
    playerSeasons: readonly Pick<UnderstatPlayerSeason, 'playerId' | 'sourceTeamTitle'>[];
  },
  rows: readonly Pick<UnderstatPlayerTeamSeason, 'playerId'>[],
  existingPlayerIds: ReadonlySet<number> = new Set(),
): UnderstatCompletenessResult {
  if (rows.length === 0) {
    return incomplete(`team ${teamId} participant rows are empty`);
  }
  const incomingPlayerIds = new Set(rows.map((row) => row.playerId));
  if (incomingPlayerIds.size !== rows.length) {
    return incomplete(`team ${teamId} participant rows contain duplicate player IDs`);
  }
  const playerIds = new Set(discovery.playerSeasons.map((player) => player.playerId));
  const unknownPlayerIds = rows
    .filter((row) => !playerIds.has(row.playerId))
    .map((row) => row.playerId);
  if (unknownPlayerIds.length > 0) {
    return incomplete(
      `team ${teamId} has participant players missing from league discovery: ${[
        ...new Set(unknownPlayerIds),
      ].join(',')}`,
    );
  }
  const expectedPlayerIds = expectedUnderstatPlayerIdsForTeam(teamId, discovery);
  const requiredPlayerIds = new Set([...existingPlayerIds, ...expectedPlayerIds]);
  const omittedPlayerIds = [...requiredPlayerIds].filter(
    (playerId) => !incomingPlayerIds.has(playerId),
  );
  if (omittedPlayerIds.length > 0) {
    return incomplete(
      `team ${teamId} participant rows incomplete: incoming=${incomingPlayerIds.size} required=${requiredPlayerIds.size} omitted=${omittedPlayerIds.join(',')}`,
    );
  }
  return complete();
}

export function evaluateUnderstatPlayerMatchResourceCompleteness(
  match: Pick<UnderstatMatch, 'id' | 'homeTeamId' | 'awayTeamId'>,
  rows: readonly Pick<UnderstatPlayerMatchStat, 'matchId' | 'teamId' | 'side' | 'started'>[],
): UnderstatCompletenessResult {
  const home = rows.filter(
    (row) => row.matchId === match.id && row.teamId === match.homeTeamId && row.side === 'h',
  );
  const away = rows.filter(
    (row) => row.matchId === match.id && row.teamId === match.awayTeamId && row.side === 'a',
  );
  if (
    home.length === 0 ||
    away.length === 0 ||
    home.filter((row) => row.started).length !== 11 ||
    away.filter((row) => row.started).length !== 11
  ) {
    return incomplete(`match ${match.id} roster is incomplete`);
  }
  return complete();
}

export function evaluateUnderstatTeamSnapshotCompleteness(
  league: string,
  snapshot: {
    teams: Array<{ team: { id: number } }>;
    matches: Array<Pick<UnderstatMatch, 'id' | 'homeTeamId' | 'awayTeamId' | 'isResult'>>;
    teamMatchRows: Array<{
      stat: { teamId: number; side: string };
      match: { id: number };
    }>;
    splits: Array<{ teamId: number; dimension: string }>;
  },
): UnderstatCompletenessResult {
  const cardinality = LEAGUE_CARDINALITY[league];
  if (cardinality && snapshot.teams.length !== cardinality.teams) {
    return incomplete(`team summaries ${snapshot.teams.length}/${cardinality.teams}`);
  }
  if (cardinality && snapshot.matches.length !== cardinality.matches) {
    return incomplete(`matches ${snapshot.matches.length}/${cardinality.matches}`);
  }

  const teamIds = new Set(snapshot.teams.map((row) => row.team.id));
  for (const teamId of teamIds) {
    const dimensions = new Set(
      snapshot.splits.filter((row) => row.teamId === teamId).map((row) => row.dimension),
    );
    const missing = UNDERSTAT_SPLIT_DIMENSIONS.filter((dimension) => !dimensions.has(dimension));
    if (missing.length > 0) {
      return incomplete(`team ${teamId} split dimensions missing: ${missing.join(',')}`);
    }
  }

  const rowsByMatch = new Map<number, Array<{ teamId: number; side: string }>>();
  for (const row of snapshot.teamMatchRows) {
    const current = rowsByMatch.get(row.match.id) ?? [];
    current.push(row.stat);
    rowsByMatch.set(row.match.id, current);
  }
  for (const match of snapshot.matches.filter((candidate) => candidate.isResult)) {
    const rows = rowsByMatch.get(match.id) ?? [];
    if (
      rows.length !== 2 ||
      !rows.some((row) => row.teamId === match.homeTeamId && row.side === 'h') ||
      !rows.some((row) => row.teamId === match.awayTeamId && row.side === 'a')
    ) {
      return incomplete(`completed match ${match.id} does not have both team-stat sides`);
    }
  }
  return complete();
}

export function evaluateUnderstatPlayerSnapshotCompleteness(
  league: string,
  matches: Array<Pick<UnderstatMatch, 'id' | 'homeTeamId' | 'awayTeamId' | 'isResult'>>,
  snapshot: {
    players: Array<{ player: { id: number } }>;
    memberships: Array<{ playerId: number; teamId: number }>;
    matchStats: Array<{
      stat: { teamId: number; side: string; started: boolean };
      match: { id: number };
    }>;
  },
): UnderstatCompletenessResult {
  if (snapshot.players.length === 0) return incomplete('player summaries are empty');

  const cardinality = LEAGUE_CARDINALITY[league];
  const membershipTeamIds = new Set(snapshot.memberships.map((row) => row.teamId));
  if (cardinality && membershipTeamIds.size !== cardinality.teams) {
    return incomplete(`participant teams ${membershipTeamIds.size}/${cardinality.teams}`);
  }

  const summaryPlayerIds = new Set(snapshot.players.map((row) => row.player.id));
  const membershipPlayerIds = new Set(snapshot.memberships.map((row) => row.playerId));
  const missingMemberships = [...summaryPlayerIds].filter(
    (playerId) => !membershipPlayerIds.has(playerId),
  );
  const orphanMemberships = [...membershipPlayerIds].filter(
    (playerId) => !summaryPlayerIds.has(playerId),
  );
  if (missingMemberships.length > 0 || orphanMemberships.length > 0) {
    return incomplete(
      `participant mismatch missing=${missingMemberships.join(',')} orphan=${orphanMemberships.join(',')}`,
    );
  }

  const statsByMatch = new Map<number, Array<{ teamId: number; side: string; started: boolean }>>();
  for (const row of snapshot.matchStats) {
    const current = statsByMatch.get(row.match.id) ?? [];
    current.push(row.stat);
    statsByMatch.set(row.match.id, current);
  }
  for (const match of matches.filter((candidate) => candidate.isResult)) {
    const rows = statsByMatch.get(match.id) ?? [];
    const home = rows.filter((row) => row.teamId === match.homeTeamId && row.side === 'h');
    const away = rows.filter((row) => row.teamId === match.awayTeamId && row.side === 'a');
    if (
      home.length === 0 ||
      away.length === 0 ||
      home.filter((row) => row.started).length !== 11 ||
      away.filter((row) => row.started).length !== 11
    ) {
      return incomplete(`completed match ${match.id} roster is incomplete`);
    }
  }
  return complete();
}

export function assertUnderstatLeagueSnapshotComplete(
  league: string,
  teamCount: number,
  matchCount: number,
): void {
  const expected = LEAGUE_CARDINALITY[league];
  if (!expected) return;
  if (teamCount !== expected.teams || matchCount !== expected.matches) {
    throw new Error(
      `Incomplete Understat ${league} snapshot: teams=${teamCount}/${expected.teams} matches=${matchCount}/${expected.matches}`,
    );
  }
}

export function assertNoUnderstatMatchesDisappeared(
  previousMatchIds: Iterable<number>,
  incomingMatches: readonly UnderstatMatch[],
): void {
  const incomingIds = new Set(incomingMatches.map((match) => match.id));
  const missing = [...previousMatchIds].filter((matchId) => !incomingIds.has(matchId));
  if (missing.length > 0) {
    throw new Error(`Understat snapshot dropped known match IDs: ${missing.join(', ')}`);
  }
}

export function withdrawnUnderstatMatchIds(
  previousMatches: readonly Pick<UnderstatMatch, 'id' | 'isResult'>[],
  incomingMatches: readonly Pick<UnderstatMatch, 'id' | 'isResult'>[],
): number[] {
  const incomingResults = new Set(
    incomingMatches.filter((match) => match.isResult).map((match) => match.id),
  );
  return previousMatches
    .filter((match) => match.isResult && !incomingResults.has(match.id))
    .map((match) => match.id)
    .sort((left, right) => left - right);
}

export function assertUnderstatSyncAllowed(season: string): {
  league: string;
  sourceYear: number;
} {
  const config = getConfig();
  if (!config.UNDERSTAT_ENABLED) {
    throw new Error('Understat synchronization is disabled');
  }
  const sourceYear = sourceYearFromSeason(season);
  const minimumSourceYear = sourceYearFromSeason(config.UNDERSTAT_MIN_SEASON);
  if (sourceYear < minimumSourceYear) {
    throw new Error(
      `Understat season ${season} is older than configured minimum ${config.UNDERSTAT_MIN_SEASON}`,
    );
  }
  if (sourceYear > sourceYearFromSeason(config.UNDERSTAT_SEASON)) {
    throw new Error(
      `Understat season ${season} is newer than configured active season ${config.UNDERSTAT_SEASON}`,
    );
  }
  return { league: config.UNDERSTAT_LEAGUE, sourceYear };
}

export function plannedUnderstatSeason(
  season: string,
  sourceYear: number,
  league: string,
  now = new Date(),
): UnderstatSeason {
  return {
    season,
    sourceYear,
    league,
    state: 'planned',
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function validateExplicitIds(
  values: readonly number[] | undefined,
  knownIds: ReadonlySet<number>,
  resource: string,
): number[] | null {
  if (!values) return null;
  const unique = [...new Set(values)].sort((left, right) => left - right);
  const unknown = unique.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown Understat ${resource} IDs: ${unknown.join(', ')}`);
  }
  return unique;
}

export function changedUnderstatTeamStatIds(
  rows: readonly Pick<UnderstatTeamMatchStat, 'matchId' | 'teamId' | 'sourceHash'>[],
  previousHashes: ReadonlyMap<string, string>,
): Set<number> {
  const ids = new Set<number>();
  for (const row of rows) {
    if (previousHashes.get(`${row.matchId}:${row.teamId}`) !== row.sourceHash) {
      ids.add(row.teamId);
    }
  }
  return ids;
}

export function changedUnderstatPlayerSeasonIds(
  rows: readonly Pick<UnderstatPlayerSeason, 'playerId' | 'sourceHash'>[],
  previousHashes: ReadonlyMap<number, string>,
  includeMissing = true,
): Set<number> {
  const incomingIds = new Set(rows.map((row) => row.playerId));
  const ids = new Set(
    rows
      .filter((row) => previousHashes.get(row.playerId) !== row.sourceHash)
      .map((row) => row.playerId),
  );
  if (includeMissing) {
    for (const playerId of previousHashes.keys()) {
      if (!incomingIds.has(playerId)) ids.add(playerId);
    }
  }
  return ids;
}

export function changedUnderstatPlayerTeamIds(
  rows: readonly Pick<UnderstatPlayerSeason, 'playerId' | 'sourceTeamTitle'>[],
  changedPlayerIds: ReadonlySet<number>,
  teams: readonly Pick<UnderstatTeam, 'id' | 'title'>[],
): Set<number> {
  const teamIdsByTitle = new Map(teams.map((team) => [team.title, team.id]));
  const ids = new Set<number>();
  for (const row of rows) {
    if (!changedPlayerIds.has(row.playerId)) continue;
    const destinationTitle = row.sourceTeamTitle
      .split(',')
      .map((title) => title.trim())
      .filter((title) => title.length > 0)
      .at(-1);
    const destinationId = destinationTitle ? teamIdsByTitle.get(destinationTitle) : undefined;
    if (destinationId !== undefined) ids.add(destinationId);
  }
  return ids;
}

export function mergeUnderstatTeamDetailIds(
  selectedTeamIds: readonly number[],
  changedTeamIds: ReadonlySet<number>,
  priorTeamIds: readonly number[] = [],
): number[] {
  return [...new Set([...selectedTeamIds, ...changedTeamIds, ...priorTeamIds])].sort(
    (left, right) => left - right,
  );
}

export function selectTeamDetailIds(input: {
  mode: UnderstatSyncMode;
  teams: readonly UnderstatTeam[];
  explicitTeamIds?: readonly number[];
  changedTeamIds: ReadonlySet<number>;
  existingTeamIds: ReadonlySet<number>;
  reconcileAll: boolean;
}): number[] {
  const knownIds = new Set(input.teams.map((team) => team.id));
  const explicit = validateExplicitIds(input.explicitTeamIds, knownIds, 'team');
  if (explicit) return explicit;
  if (input.mode === 'full' || (input.mode === 'reconcile' && input.reconcileAll)) {
    return [...knownIds].sort((left, right) => left - right);
  }
  return input.teams
    .filter(
      (team) =>
        !input.existingTeamIds.has(team.id) ||
        (input.mode === 'incremental' && input.changedTeamIds.has(team.id)),
    )
    .map((team) => team.id)
    .sort((left, right) => left - right);
}

export function selectPlayerMatchIds(input: {
  mode: UnderstatSyncMode;
  matches: readonly UnderstatMatch[];
  syncedMatchIds: ReadonlySet<number>;
  explicitMatchIds?: readonly number[];
  requiredMatchIds?: Iterable<number>;
  now?: Date;
  reconcileLimit?: number;
}): number[] {
  const completed = input.matches.filter((match) => match.isResult);
  const knownIds = new Set(completed.map((match) => match.id));
  const explicit = validateExplicitIds(input.explicitMatchIds, knownIds, 'completed match');
  if (explicit) {
    const selected = new Set(explicit);
    for (const matchId of input.requiredMatchIds ?? []) {
      if (knownIds.has(matchId)) selected.add(matchId);
    }
    return [...selected].sort((left, right) => left - right);
  }
  if (input.mode === 'full') return completed.map((match) => match.id).sort((a, b) => a - b);

  const now = input.now ?? new Date();
  const correctionCutoff = now.getTime() - 72 * 60 * 60 * 1000;
  const required = new Set(
    [...(input.requiredMatchIds ?? [])].filter((matchId) => knownIds.has(matchId)),
  );
  for (const match of completed) {
    if (!input.syncedMatchIds.has(match.id) || match.kickoffAt.getTime() >= correctionCutoff) {
      required.add(match.id);
    }
  }

  if (input.mode === 'reconcile') {
    const older = completed
      .filter((match) => match.kickoffAt.getTime() < correctionCutoff)
      .sort((left, right) => left.kickoffAt.getTime() - right.kickoffAt.getTime());
    const limit = Math.min(input.reconcileLimit ?? 10, older.length);
    if (limit > 0) {
      const utcDay = Math.floor(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000,
      );
      const start = (utcDay * limit) % older.length;
      for (let index = 0; index < limit; index += 1) {
        required.add(older[(start + index) % older.length].id);
      }
    }
  }

  return [...required].sort((left, right) => left - right);
}

export function teamById(teams: readonly UnderstatTeam[]): Map<number, UnderstatTeam> {
  return new Map(teams.map((team) => [team.id, team]));
}
