import type {
  UnderstatMatch,
  UnderstatPlayerSeason,
  UnderstatSeason,
  UnderstatSyncMode,
  UnderstatTeam,
  UnderstatTeamMatchStat,
} from '../domain/understat';
import { sourceYearFromSeason } from '../domain/understat';
import { getConfig } from '../utils/config';

const LEAGUE_CARDINALITY: Readonly<Record<string, { teams: number; matches: number }>> = {
  EPL: { teams: 20, matches: 380 },
};

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
  if (sourceYear < 2026) {
    throw new Error(`Understat production persistence starts at 2026/27, received ${season}`);
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
