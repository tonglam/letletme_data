import type {
  UnderstatMatch,
  UnderstatPlayerSeason,
  UnderstatSeason,
  UnderstatSyncMode,
  UnderstatTeam,
  UnderstatTeamMatchStat,
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

function incomplete(reason: string): UnderstatCompletenessResult {
  return { complete: false, reason };
}

function complete(): UnderstatCompletenessResult {
  return { complete: true, reason: 'complete' };
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
): Set<number> {
  const incomingIds = new Set(rows.map((row) => row.playerId));
  const ids = new Set(
    rows
      .filter((row) => previousHashes.get(row.playerId) !== row.sourceHash)
      .map((row) => row.playerId),
  );
  for (const playerId of previousHashes.keys()) {
    if (!incomingIds.has(playerId)) ids.add(playerId);
  }
  return ids;
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
  now?: Date;
  reconcileLimit?: number;
}): number[] {
  const completed = input.matches.filter((match) => match.isResult);
  const knownIds = new Set(completed.map((match) => match.id));
  const explicit = validateExplicitIds(input.explicitMatchIds, knownIds, 'completed match');
  if (explicit) return explicit;
  if (input.mode === 'full') return completed.map((match) => match.id).sort((a, b) => a - b);

  const now = input.now ?? new Date();
  const correctionCutoff = now.getTime() - 72 * 60 * 60 * 1000;
  const required = new Set(
    completed
      .filter(
        (match) =>
          !input.syncedMatchIds.has(match.id) || match.kickoffAt.getTime() >= correctionCutoff,
      )
      .map((match) => match.id),
  );

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
