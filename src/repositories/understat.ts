import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';

import {
  matchesInUnderstat as understatMatches,
  playersInUnderstat as understatPlayers,
  playerMatchStatsInUnderstat as understatPlayerMatchStats,
  playerSeasonsInUnderstat as understatPlayerSeasons,
  playerTeamSeasonsInUnderstat as understatPlayerTeamSeasons,
  seasonsInUnderstat as understatSeasons,
  teamMatchStatsInUnderstat as understatTeamMatchStats,
  teamsInUnderstat as understatTeams,
  teamSeasonsInUnderstat as understatTeamSeasons,
  teamStatSplitsInUnderstat as understatTeamStatSplits,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type {
  UnderstatMatch,
  UnderstatPlayer,
  UnderstatPlayerMatchStat,
  UnderstatPlayerSeason,
  UnderstatPlayerTeamSeason,
  UnderstatSeason,
  UnderstatTeam,
  UnderstatTeamMatchStat,
  UnderstatTeamSeason,
  UnderstatTeamStatSplit,
} from '../domain/understat';
import { UNDERSTAT_SPLIT_DIMENSIONS } from '../domain/understat';

async function getDatabase(dbInstance?: DbOrTransaction): Promise<DbOrTransaction> {
  return dbInstance ?? (await getDb());
}

const toSeasonRow = ({ season, ...row }: UnderstatSeason) => ({
  ...row,
  seasonCode: season,
});

const toTeamRow = ({ id, ...row }: UnderstatTeam) => ({
  ...row,
  teamId: id,
});

const toMatchRow = ({ id, season, ...row }: UnderstatMatch) => ({
  ...row,
  matchId: id,
  seasonCode: season,
});

const toTeamSeasonRow = ({ season, ...row }: UnderstatTeamSeason) => ({
  ...row,
  seasonCode: season,
});

const toTeamSplitRow = ({ season, ...row }: UnderstatTeamStatSplit) => ({
  ...row,
  seasonCode: season,
});

const toPlayerRow = ({ id, ...row }: UnderstatPlayer) => ({
  ...row,
  playerId: id,
});

const toPlayerSeasonRow = ({ season, time, npg, npxg, ...row }: UnderstatPlayerSeason) => ({
  ...row,
  seasonCode: season,
  timeMinutes: time,
  nonPenaltyGoals: npg,
  nonPenaltyXg: npxg,
});

const toPlayerTeamSeasonRow = ({ season, time, npg, npxg, ...row }: UnderstatPlayerTeamSeason) => ({
  ...row,
  seasonCode: season,
  timeMinutes: time,
  nonPenaltyGoals: npg,
  nonPenaltyXg: npxg,
});

function mapTeam(row: typeof understatTeams.$inferSelect): UnderstatTeam {
  return {
    id: row.teamId,
    title: row.title,
    shortTitle: row.shortTitle,
    firstSeenSeason: row.firstSeenSeason,
    lastSeenSeason: row.lastSeenSeason,
    sourceHash: row.sourceHash,
  };
}

function mapMatch(row: typeof understatMatches.$inferSelect): UnderstatMatch {
  return {
    id: row.matchId,
    season: row.seasonCode,
    homeTeamId: row.homeTeamId,
    awayTeamId: row.awayTeamId,
    kickoffAt: row.kickoffAt,
    isResult: row.isResult,
    homeGoals: row.homeGoals,
    awayGoals: row.awayGoals,
    homeXg: row.homeXg,
    awayXg: row.awayXg,
    forecastHomeWin: row.forecastHomeWin,
    forecastDraw: row.forecastDraw,
    forecastAwayWin: row.forecastAwayWin,
    sourceHash: row.sourceHash,
    sourceCheckedAt: row.sourceCheckedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function mapTeamSeason(row: typeof understatTeamSeasons.$inferSelect): UnderstatTeamSeason {
  const { seasonCode, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = row;
  return { ...rest, season: seasonCode };
}

function mapTeamSplit(row: typeof understatTeamStatSplits.$inferSelect): UnderstatTeamStatSplit {
  const { seasonCode, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = row;
  const dimension = UNDERSTAT_SPLIT_DIMENSIONS.find((value) => value === row.dimension);
  if (!dimension) throw new Error(`Unknown Understat split dimension: ${row.dimension}`);
  return { ...rest, dimension, season: seasonCode };
}

function mapPlayer(row: typeof understatPlayers.$inferSelect): UnderstatPlayer {
  return {
    id: row.playerId,
    name: row.name,
    favoritePosition: row.favoritePosition,
    firstSeenSeason: row.firstSeenSeason,
    lastSeenSeason: row.lastSeenSeason,
    sourceHash: row.sourceHash,
  };
}

function mapPlayerSeason(row: typeof understatPlayerSeasons.$inferSelect): UnderstatPlayerSeason {
  const {
    seasonCode,
    timeMinutes,
    nonPenaltyGoals,
    nonPenaltyXg,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = row;
  return {
    ...rest,
    season: seasonCode,
    time: timeMinutes,
    npg: nonPenaltyGoals,
    npxg: nonPenaltyXg,
  };
}

function mapPlayerTeamSeason(
  row: typeof understatPlayerTeamSeasons.$inferSelect,
): UnderstatPlayerTeamSeason {
  const {
    seasonCode,
    timeMinutes,
    nonPenaltyGoals,
    nonPenaltyXg,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = row;
  return {
    ...rest,
    season: seasonCode,
    time: timeMinutes,
    npg: nonPenaltyGoals,
    npxg: nonPenaltyXg,
  };
}

export const createUnderstatReferenceRepository = (dbInstance?: DbOrTransaction) => ({
  async ensureSeason(season: UnderstatSeason): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db.insert(understatSeasons).values(toSeasonRow(season)).onConflictDoNothing({
      target: understatSeasons.seasonCode,
    });
  },

  async upsertSeason(season: UnderstatSeason): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .insert(understatSeasons)
      .values(toSeasonRow(season))
      .onConflictDoUpdate({
        target: understatSeasons.seasonCode,
        set: {
          sourceYear: sql`excluded.source_year`,
          league: sql`excluded.league`,
          state: sql`CASE
            WHEN ${understatSeasons.state} = 'complete' OR excluded.state = 'complete' THEN 'complete'::understat.season_state
            WHEN ${understatSeasons.state} = 'active' OR excluded.state = 'active' THEN 'active'::understat.season_state
            ELSE 'planned'::understat.season_state
          END`,
          firstSeenAt: sql`LEAST(${understatSeasons.firstSeenAt}, excluded.first_seen_at)`,
          lastSeenAt: sql`GREATEST(${understatSeasons.lastSeenAt}, excluded.last_seen_at)`,
          updatedAt: sql`NOW()`,
        },
      });
  },

  async completeOlderSeasons(activeSeason: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSeasons)
      .set({ state: 'complete', updatedAt: new Date() })
      .where(
        and(lt(understatSeasons.seasonCode, activeSeason), eq(understatSeasons.state, 'active')),
      );
  },

  async upsertTeams(rows: UnderstatTeam[]): Promise<number> {
    if (rows.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const result = await db
      .insert(understatTeams)
      .values(rows.map(toTeamRow))
      .onConflictDoUpdate({
        target: understatTeams.teamId,
        set: {
          title: sql`CASE
            WHEN excluded.last_seen_season >= ${understatTeams.lastSeenSeason}
              THEN excluded.title
            ELSE ${understatTeams.title}
          END`,
          shortTitle: sql`CASE
            WHEN excluded.last_seen_season >= ${understatTeams.lastSeenSeason}
              THEN excluded.short_title
            ELSE ${understatTeams.shortTitle}
          END`,
          firstSeenSeason: sql`LEAST(${understatTeams.firstSeenSeason}, excluded.first_seen_season)`,
          lastSeenSeason: sql`GREATEST(${understatTeams.lastSeenSeason}, excluded.last_seen_season)`,
          sourceHash: sql`CASE
            WHEN excluded.last_seen_season >= ${understatTeams.lastSeenSeason}
              THEN excluded.source_hash
            ELSE ${understatTeams.sourceHash}
          END`,
          updatedAt: sql`NOW()`,
        },
        setWhere: sql`
          ${understatTeams.firstSeenSeason} > excluded.first_seen_season
          OR ${understatTeams.lastSeenSeason} < excluded.last_seen_season
          OR (
            excluded.last_seen_season >= ${understatTeams.lastSeenSeason}
            AND ${understatTeams.sourceHash} IS DISTINCT FROM excluded.source_hash
          )
        `,
      })
      .returning({ id: understatTeams.teamId });
    return result.length;
  },

  async findTeamsByIds(teamIds: readonly number[]): Promise<UnderstatTeam[]> {
    if (teamIds.length === 0) return [];
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select()
      .from(understatTeams)
      .where(inArray(understatTeams.teamId, [...new Set(teamIds)]));
    return rows.map(mapTeam);
  },

  async getMatchHashes(season: string): Promise<Map<number, string>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ id: understatMatches.matchId, sourceHash: understatMatches.sourceHash })
      .from(understatMatches)
      .where(eq(understatMatches.seasonCode, season));
    return new Map(rows.map((row) => [row.id, row.sourceHash]));
  },

  async upsertMatches(rows: UnderstatMatch[]): Promise<number> {
    if (rows.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const existing = await db
      .select({ id: understatMatches.matchId, sourceHash: understatMatches.sourceHash })
      .from(understatMatches)
      .where(
        inArray(
          understatMatches.matchId,
          rows.map((row) => row.id),
        ),
      );
    const existingHashes = new Map(existing.map((row) => [row.id, row.sourceHash]));
    const businessChanges = rows.filter(
      (row) => existingHashes.get(row.id) !== row.sourceHash,
    ).length;
    await db
      .insert(understatMatches)
      .values(rows.map(toMatchRow))
      .onConflictDoUpdate({
        target: understatMatches.matchId,
        set: {
          seasonCode: sql`excluded.season_code`,
          homeTeamId: sql`excluded.home_team_id`,
          awayTeamId: sql`excluded.away_team_id`,
          kickoffAt: sql`excluded.kickoff_at`,
          isResult: sql`excluded.is_result`,
          homeGoals: sql`excluded.home_goals`,
          awayGoals: sql`excluded.away_goals`,
          homeXg: sql`excluded.home_xg`,
          awayXg: sql`excluded.away_xg`,
          forecastHomeWin: sql`excluded.forecast_home_win`,
          forecastDraw: sql`excluded.forecast_draw`,
          forecastAwayWin: sql`excluded.forecast_away_win`,
          sourceHash: sql`excluded.source_hash`,
          sourceCheckedAt: sql`excluded.source_checked_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`NOW()`,
        },
        setWhere: sql`excluded.source_checked_at > ${understatMatches.sourceCheckedAt}`,
      });
    return businessChanges;
  },

  async findMatchesBySeason(season: string): Promise<UnderstatMatch[]> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select()
      .from(understatMatches)
      .where(eq(understatMatches.seasonCode, season))
      .orderBy(asc(understatMatches.kickoffAt));
    return rows.map(mapMatch);
  },
});

export const createUnderstatTeamRepository = (dbInstance?: DbOrTransaction) => ({
  async deleteMatchStats(matchIds: readonly number[]): Promise<number> {
    if (matchIds.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const result = await db
      .delete(understatTeamMatchStats)
      .where(inArray(understatTeamMatchStats.matchId, [...matchIds]))
      .returning({ matchId: understatTeamMatchStats.matchId });
    return result.length;
  },

  async getMatchStatHashes(season: string): Promise<Map<string, string>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({
        matchId: understatTeamMatchStats.matchId,
        teamId: understatTeamMatchStats.teamId,
        sourceHash: understatTeamMatchStats.sourceHash,
      })
      .from(understatTeamMatchStats)
      .innerJoin(understatMatches, eq(understatTeamMatchStats.matchId, understatMatches.matchId))
      .where(eq(understatMatches.seasonCode, season));
    return new Map(rows.map((row) => [`${row.matchId}:${row.teamId}`, row.sourceHash]));
  },

  async upsertMatchStats(rows: UnderstatTeamMatchStat[]): Promise<number> {
    if (rows.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const result = await db
      .insert(understatTeamMatchStats)
      .values(rows)
      .onConflictDoUpdate({
        target: [understatTeamMatchStats.matchId, understatTeamMatchStats.teamId],
        set: {
          side: sql`excluded.side`,
          xg: sql`excluded.xg`,
          xga: sql`excluded.xga`,
          npxg: sql`excluded.npxg`,
          npxga: sql`excluded.npxga`,
          npxgd: sql`excluded.npxgd`,
          ppdaAtt: sql`excluded.ppda_att`,
          ppdaDef: sql`excluded.ppda_def`,
          ppdaAllowedAtt: sql`excluded.ppda_allowed_att`,
          ppdaAllowedDef: sql`excluded.ppda_allowed_def`,
          deep: sql`excluded.deep`,
          deepAllowed: sql`excluded.deep_allowed`,
          scored: sql`excluded.scored`,
          missed: sql`excluded.missed`,
          xpoints: sql`excluded.xpoints`,
          result: sql`excluded.result`,
          points: sql`excluded.points`,
          wins: sql`excluded.wins`,
          draws: sql`excluded.draws`,
          losses: sql`excluded.losses`,
          sourceHash: sql`excluded.source_hash`,
          updatedAt: sql`NOW()`,
        },
        setWhere: sql`${understatTeamMatchStats.sourceHash} IS DISTINCT FROM excluded.source_hash`,
      })
      .returning({ matchId: understatTeamMatchStats.matchId });
    return result.length;
  },

  async upsertTeamSeasons(rows: UnderstatTeamSeason[]): Promise<number> {
    if (rows.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const result = await db
      .insert(understatTeamSeasons)
      .values(rows.map(toTeamSeasonRow))
      .onConflictDoUpdate({
        target: [understatTeamSeasons.seasonCode, understatTeamSeasons.teamId],
        set: {
          sourceTitle: sql`excluded.source_title`,
          sourceShortTitle: sql`excluded.source_short_title`,
          games: sql`excluded.games`,
          wins: sql`excluded.wins`,
          draws: sql`excluded.draws`,
          losses: sql`excluded.losses`,
          goalsFor: sql`excluded.goals_for`,
          goalsAgainst: sql`excluded.goals_against`,
          points: sql`excluded.points`,
          xg: sql`excluded.xg`,
          xga: sql`excluded.xga`,
          npxg: sql`excluded.npxg`,
          npxga: sql`excluded.npxga`,
          npxgd: sql`excluded.npxgd`,
          xpoints: sql`excluded.xpoints`,
          deep: sql`excluded.deep`,
          deepAllowed: sql`excluded.deep_allowed`,
          ppdaAtt: sql`excluded.ppda_att`,
          ppdaDef: sql`excluded.ppda_def`,
          ppdaAllowedAtt: sql`excluded.ppda_allowed_att`,
          ppdaAllowedDef: sql`excluded.ppda_allowed_def`,
          sourceHash: sql`excluded.source_hash`,
          lastSyncedAt: sql`excluded.last_synced_at`,
          updatedAt: sql`NOW()`,
        },
        setWhere: sql`${understatTeamSeasons.sourceHash} IS DISTINCT FROM excluded.source_hash`,
      })
      .returning({ teamId: understatTeamSeasons.teamId });
    return result.length;
  },

  async getTeamIdsWithSplits(season: string): Promise<Set<number>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ teamId: understatTeamStatSplits.teamId })
      .from(understatTeamStatSplits)
      .where(eq(understatTeamStatSplits.seasonCode, season))
      .groupBy(understatTeamStatSplits.teamId);
    return new Set(rows.map((row) => row.teamId));
  },

  async getSplitHashes(season: string, teamId: number): Promise<string[]> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ sourceHash: understatTeamStatSplits.sourceHash })
      .from(understatTeamStatSplits)
      .where(
        and(
          eq(understatTeamStatSplits.seasonCode, season),
          eq(understatTeamStatSplits.teamId, teamId),
        ),
      );
    return rows.map((row) => row.sourceHash).sort();
  },

  async replaceSplits(
    season: string,
    teamId: number,
    rows: UnderstatTeamStatSplit[],
  ): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const existing = await db
      .select({
        dimension: understatTeamStatSplits.dimension,
        splitKey: understatTeamStatSplits.splitKey,
        sourceHash: understatTeamStatSplits.sourceHash,
      })
      .from(understatTeamStatSplits)
      .where(
        and(
          eq(understatTeamStatSplits.seasonCode, season),
          eq(understatTeamStatSplits.teamId, teamId),
        ),
      );
    const existingHashes = existing
      .map((row) => `${row.dimension}:${row.splitKey}:${row.sourceHash}`)
      .sort();
    const incomingHashes = rows
      .map((row) => `${row.dimension}:${row.splitKey}:${row.sourceHash}`)
      .sort();
    if (existing.length > 0 && rows.length === 0) {
      throw new Error(
        `Refusing to clear non-empty Understat team splits: season=${season} team=${teamId}`,
      );
    }
    if (
      existingHashes.length === incomingHashes.length &&
      existingHashes.every((v, i) => v === incomingHashes[i])
    ) {
      return false;
    }
    await db
      .delete(understatTeamStatSplits)
      .where(
        and(
          eq(understatTeamStatSplits.seasonCode, season),
          eq(understatTeamStatSplits.teamId, teamId),
        ),
      );
    if (rows.length > 0) {
      await db.insert(understatTeamStatSplits).values(rows.map(toTeamSplitRow));
    }
    return true;
  },

  async readSnapshot(season: string) {
    const db = await getDatabase(dbInstance);
    const [teams, matches, teamMatchRows, splits] = await Promise.all([
      db
        .select({ team: understatTeams, season: understatTeamSeasons })
        .from(understatTeamSeasons)
        .innerJoin(understatTeams, eq(understatTeamSeasons.teamId, understatTeams.teamId))
        .where(eq(understatTeamSeasons.seasonCode, season))
        .orderBy(asc(understatTeamSeasons.teamId)),
      db
        .select()
        .from(understatMatches)
        .where(eq(understatMatches.seasonCode, season))
        .orderBy(asc(understatMatches.kickoffAt), asc(understatMatches.matchId)),
      db
        .select({ stat: understatTeamMatchStats, match: understatMatches })
        .from(understatTeamMatchStats)
        .innerJoin(understatMatches, eq(understatTeamMatchStats.matchId, understatMatches.matchId))
        .where(and(eq(understatMatches.seasonCode, season), eq(understatMatches.isResult, true)))
        .orderBy(
          asc(understatTeamMatchStats.teamId),
          asc(understatMatches.kickoffAt),
          asc(understatMatches.matchId),
        ),
      db
        .select()
        .from(understatTeamStatSplits)
        .where(eq(understatTeamStatSplits.seasonCode, season))
        .orderBy(
          asc(understatTeamStatSplits.teamId),
          asc(understatTeamStatSplits.dimension),
          asc(understatTeamStatSplits.splitKey),
        ),
    ]);
    return {
      teams: teams.map((row) => ({ team: mapTeam(row.team), season: mapTeamSeason(row.season) })),
      matches: matches.map(mapMatch),
      teamMatchRows: teamMatchRows.map((row) => ({
        stat: row.stat,
        match: mapMatch(row.match),
      })),
      splits: splits.map(mapTeamSplit),
    };
  },
});

export const createUnderstatPlayerRepository = (dbInstance?: DbOrTransaction) => ({
  async getPlayerSeasonHashes(season: string): Promise<Map<number, string>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({
        playerId: understatPlayerSeasons.playerId,
        sourceHash: understatPlayerSeasons.sourceHash,
      })
      .from(understatPlayerSeasons)
      .where(eq(understatPlayerSeasons.seasonCode, season));
    return new Map(rows.map((row) => [row.playerId, row.sourceHash]));
  },

  async getTeamIdsForPlayers(season: string, playerIds: number[]): Promise<Set<number>> {
    if (playerIds.length === 0) return new Set();
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ teamId: understatPlayerTeamSeasons.teamId })
      .from(understatPlayerTeamSeasons)
      .where(
        and(
          eq(understatPlayerTeamSeasons.seasonCode, season),
          inArray(understatPlayerTeamSeasons.playerId, playerIds),
        ),
      )
      .groupBy(understatPlayerTeamSeasons.teamId);
    return new Set(rows.map((row) => row.teamId));
  },

  async upsertPlayers(rows: UnderstatPlayer[]): Promise<number> {
    if (rows.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const result = await db
      .insert(understatPlayers)
      .values(rows.map(toPlayerRow))
      .onConflictDoUpdate({
        target: understatPlayers.playerId,
        set: {
          name: sql`CASE
            WHEN excluded.last_seen_season >= ${understatPlayers.lastSeenSeason}
              THEN excluded.name
            ELSE ${understatPlayers.name}
          END`,
          favoritePosition: sql`COALESCE(excluded.favorite_position, ${understatPlayers.favoritePosition})`,
          firstSeenSeason: sql`LEAST(${understatPlayers.firstSeenSeason}, excluded.first_seen_season)`,
          lastSeenSeason: sql`GREATEST(${understatPlayers.lastSeenSeason}, excluded.last_seen_season)`,
          sourceHash: sql`CASE
            WHEN excluded.last_seen_season >= ${understatPlayers.lastSeenSeason}
              THEN excluded.source_hash
            ELSE ${understatPlayers.sourceHash}
          END`,
          updatedAt: sql`NOW()`,
        },
        setWhere: sql`
          ${understatPlayers.firstSeenSeason} > excluded.first_seen_season
          OR ${understatPlayers.lastSeenSeason} < excluded.last_seen_season
          OR (
            excluded.last_seen_season >= ${understatPlayers.lastSeenSeason}
            AND ${understatPlayers.sourceHash} IS DISTINCT FROM excluded.source_hash
          )
          OR (
            ${understatPlayers.favoritePosition} IS NULL
            AND excluded.favorite_position IS NOT NULL
          )
        `,
      })
      .returning({ id: understatPlayers.playerId });
    return result.length;
  },

  async replacePlayerSeasons(
    season: string,
    rows: UnderstatPlayerSeason[],
    preserveExisting = false,
  ): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const incomingIds = new Set(rows.map((row) => row.playerId));
    if (incomingIds.size !== rows.length) {
      throw new Error(`Understat player season ${season} contains duplicate player IDs`);
    }
    const existing = await db
      .select({
        playerId: understatPlayerSeasons.playerId,
        sourceHash: understatPlayerSeasons.sourceHash,
      })
      .from(understatPlayerSeasons)
      .where(eq(understatPlayerSeasons.seasonCode, season));
    if (!preserveExisting && existing.length > 0 && rows.length === 0) {
      throw new Error(`Refusing to clear non-empty Understat player season ${season}`);
    }
    if (preserveExisting && rows.length === 0) return false;
    const oldMap = new Map(existing.map((row) => [row.playerId, row.sourceHash]));
    const staleIds = preserveExisting
      ? []
      : existing.map((row) => row.playerId).filter((playerId) => !incomingIds.has(playerId));
    const changedRows = rows.filter((row) => oldMap.get(row.playerId) !== row.sourceHash);
    if (changedRows.length === 0 && staleIds.length === 0) return false;
    if (staleIds.length > 0) {
      await db
        .delete(understatPlayerSeasons)
        .where(
          and(
            eq(understatPlayerSeasons.seasonCode, season),
            inArray(understatPlayerSeasons.playerId, staleIds),
          ),
        );
    }
    if (changedRows.length > 0) {
      await db
        .insert(understatPlayerSeasons)
        .values(changedRows.map(toPlayerSeasonRow))
        .onConflictDoUpdate({
          target: [understatPlayerSeasons.seasonCode, understatPlayerSeasons.playerId],
          set: {
            sourceName: sql`excluded.source_name`,
            sourceTeamTitle: sql`excluded.source_team_title`,
            games: sql`excluded.games`,
            timeMinutes: sql`excluded.time_minutes`,
            goals: sql`excluded.goals`,
            nonPenaltyGoals: sql`excluded.non_penalty_goals`,
            assists: sql`excluded.assists`,
            shots: sql`excluded.shots`,
            keyPasses: sql`excluded.key_passes`,
            yellowCards: sql`excluded.yellow_cards`,
            redCards: sql`excluded.red_cards`,
            xg: sql`excluded.xg`,
            nonPenaltyXg: sql`excluded.non_penalty_xg`,
            xa: sql`excluded.xa`,
            xgChain: sql`excluded.xg_chain`,
            xgBuildup: sql`excluded.xg_buildup`,
            position: sql`excluded.position`,
            sourceHash: sql`excluded.source_hash`,
            updatedAt: sql`NOW()`,
          },
          setWhere: sql`${understatPlayerSeasons.sourceHash} IS DISTINCT FROM excluded.source_hash`,
        });
    }
    return true;
  },

  async hasTeamParticipants(season: string, teamId: number): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const [row] = await db
      .select({ playerId: understatPlayerTeamSeasons.playerId })
      .from(understatPlayerTeamSeasons)
      .where(
        and(
          eq(understatPlayerTeamSeasons.seasonCode, season),
          eq(understatPlayerTeamSeasons.teamId, teamId),
        ),
      )
      .limit(1);
    return row !== undefined;
  },

  async getTeamParticipantPlayerIds(season: string, teamId: number): Promise<Set<number>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ playerId: understatPlayerTeamSeasons.playerId })
      .from(understatPlayerTeamSeasons)
      .where(
        and(
          eq(understatPlayerTeamSeasons.seasonCode, season),
          eq(understatPlayerTeamSeasons.teamId, teamId),
        ),
      );
    return new Set(rows.map((row) => row.playerId));
  },

  async getTeamIdsWithParticipants(season: string): Promise<Set<number>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ teamId: understatPlayerTeamSeasons.teamId })
      .from(understatPlayerTeamSeasons)
      .where(eq(understatPlayerTeamSeasons.seasonCode, season))
      .groupBy(understatPlayerTeamSeasons.teamId);
    return new Set(rows.map((row) => row.teamId));
  },

  async getTeamParticipantHashes(season: string, teamId: number): Promise<string[]> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ sourceHash: understatPlayerTeamSeasons.sourceHash })
      .from(understatPlayerTeamSeasons)
      .where(
        and(
          eq(understatPlayerTeamSeasons.seasonCode, season),
          eq(understatPlayerTeamSeasons.teamId, teamId),
        ),
      );
    return rows.map((row) => row.sourceHash).sort();
  },

  async replaceTeamParticipants(
    season: string,
    teamId: number,
    rows: UnderstatPlayerTeamSeason[],
    removeStale = true,
  ): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const incomingIds = new Set(rows.map((row) => row.playerId));
    if (incomingIds.size !== rows.length) {
      throw new Error(
        `Understat team participants contain duplicate players: season=${season} team=${teamId}`,
      );
    }
    const existing = await db
      .select({
        playerId: understatPlayerTeamSeasons.playerId,
        sourceHash: understatPlayerTeamSeasons.sourceHash,
      })
      .from(understatPlayerTeamSeasons)
      .where(
        and(
          eq(understatPlayerTeamSeasons.seasonCode, season),
          eq(understatPlayerTeamSeasons.teamId, teamId),
        ),
      );
    if (removeStale && existing.length > 0 && rows.length === 0) {
      throw new Error(
        `Refusing to clear non-empty Understat team participants: season=${season} team=${teamId}`,
      );
    }
    if (!removeStale && rows.length === 0) return false;
    const oldMap = new Map(existing.map((row) => [row.playerId, row.sourceHash]));
    const staleIds = removeStale
      ? existing.map((row) => row.playerId).filter((playerId) => !incomingIds.has(playerId))
      : [];
    const changedRows = rows.filter((row) => oldMap.get(row.playerId) !== row.sourceHash);
    if (changedRows.length === 0 && staleIds.length === 0) return false;
    if (staleIds.length > 0) {
      await db
        .delete(understatPlayerTeamSeasons)
        .where(
          and(
            eq(understatPlayerTeamSeasons.seasonCode, season),
            eq(understatPlayerTeamSeasons.teamId, teamId),
            inArray(understatPlayerTeamSeasons.playerId, staleIds),
          ),
        );
    }
    if (changedRows.length > 0) {
      await db
        .insert(understatPlayerTeamSeasons)
        .values(changedRows.map(toPlayerTeamSeasonRow))
        .onConflictDoUpdate({
          target: [
            understatPlayerTeamSeasons.seasonCode,
            understatPlayerTeamSeasons.playerId,
            understatPlayerTeamSeasons.teamId,
          ],
          set: {
            games: sql`excluded.games`,
            timeMinutes: sql`excluded.time_minutes`,
            goals: sql`excluded.goals`,
            nonPenaltyGoals: sql`excluded.non_penalty_goals`,
            assists: sql`excluded.assists`,
            shots: sql`excluded.shots`,
            keyPasses: sql`excluded.key_passes`,
            yellowCards: sql`excluded.yellow_cards`,
            redCards: sql`excluded.red_cards`,
            xg: sql`excluded.xg`,
            nonPenaltyXg: sql`excluded.non_penalty_xg`,
            xa: sql`excluded.xa`,
            xgChain: sql`excluded.xg_chain`,
            xgBuildup: sql`excluded.xg_buildup`,
            position: sql`excluded.position`,
            sourceHash: sql`excluded.source_hash`,
            updatedAt: sql`NOW()`,
          },
          setWhere: sql`${understatPlayerTeamSeasons.sourceHash} IS DISTINCT FROM excluded.source_hash`,
        });
    }
    return true;
  },

  async getSyncedMatchIds(matchIds: number[]): Promise<Set<number>> {
    if (matchIds.length === 0) return new Set();
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ matchId: understatPlayerMatchStats.matchId })
      .from(understatPlayerMatchStats)
      .where(inArray(understatPlayerMatchStats.matchId, matchIds))
      .groupBy(understatPlayerMatchStats.matchId);
    return new Set(rows.map((row) => row.matchId));
  },

  async deleteMatchStats(matchIds: readonly number[]): Promise<number> {
    if (matchIds.length === 0) return 0;
    const db = await getDatabase(dbInstance);
    const result = await db
      .delete(understatPlayerMatchStats)
      .where(inArray(understatPlayerMatchStats.matchId, [...matchIds]))
      .returning({ matchId: understatPlayerMatchStats.matchId });
    return result.length;
  },

  async getMatchIdsForPlayers(season: string, playerIds: readonly number[]): Promise<Set<number>> {
    if (playerIds.length === 0) return new Set();
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ matchId: understatPlayerMatchStats.matchId })
      .from(understatPlayerMatchStats)
      .innerJoin(understatMatches, eq(understatPlayerMatchStats.matchId, understatMatches.matchId))
      .where(
        and(
          eq(understatMatches.seasonCode, season),
          eq(understatMatches.isResult, true),
          inArray(understatPlayerMatchStats.playerId, [...playerIds]),
        ),
      )
      .groupBy(understatPlayerMatchStats.matchId);
    return new Set(rows.map((row) => row.matchId));
  },

  async getMatchStatHashes(matchId: number): Promise<string[]> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ sourceHash: understatPlayerMatchStats.sourceHash })
      .from(understatPlayerMatchStats)
      .where(eq(understatPlayerMatchStats.matchId, matchId));
    return rows.map((row) => row.sourceHash).sort();
  },

  async replaceMatchStats(matchId: number, rows: UnderstatPlayerMatchStat[]): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const existing = await db
      .select({
        rosterId: understatPlayerMatchStats.rosterId,
        sourceHash: understatPlayerMatchStats.sourceHash,
      })
      .from(understatPlayerMatchStats)
      .where(eq(understatPlayerMatchStats.matchId, matchId));
    const oldMap = new Map(existing.map((row) => [row.rosterId, row.sourceHash]));
    const changed =
      rows.length !== existing.length ||
      rows.some((row) => oldMap.get(row.rosterId) !== row.sourceHash);
    if (!changed) return false;
    await db
      .delete(understatPlayerMatchStats)
      .where(eq(understatPlayerMatchStats.matchId, matchId));
    if (rows.length > 0) await db.insert(understatPlayerMatchStats).values(rows);
    return true;
  },

  async readSnapshot(season: string) {
    const db = await getDatabase(dbInstance);
    const [players, memberships, matchStats] = await Promise.all([
      db
        .select({ player: understatPlayers, season: understatPlayerSeasons })
        .from(understatPlayerSeasons)
        .innerJoin(understatPlayers, eq(understatPlayerSeasons.playerId, understatPlayers.playerId))
        .where(eq(understatPlayerSeasons.seasonCode, season))
        .orderBy(asc(understatPlayerSeasons.playerId)),
      db
        .select()
        .from(understatPlayerTeamSeasons)
        .where(eq(understatPlayerTeamSeasons.seasonCode, season))
        .orderBy(asc(understatPlayerTeamSeasons.playerId), asc(understatPlayerTeamSeasons.teamId)),
      db
        .select({ stat: understatPlayerMatchStats, match: understatMatches })
        .from(understatPlayerMatchStats)
        .innerJoin(
          understatMatches,
          eq(understatPlayerMatchStats.matchId, understatMatches.matchId),
        )
        .where(and(eq(understatMatches.seasonCode, season), eq(understatMatches.isResult, true)))
        .orderBy(
          asc(understatPlayerMatchStats.playerId),
          asc(understatMatches.kickoffAt),
          asc(understatMatches.matchId),
        ),
    ]);
    return {
      players: players.map((row) => ({
        player: mapPlayer(row.player),
        season: mapPlayerSeason(row.season),
      })),
      memberships: memberships.map(mapPlayerTeamSeason),
      matchStats: matchStats.map((row) => ({
        stat: row.stat,
        match: mapMatch(row.match),
      })),
    };
  },
});

export const understatReferenceRepository = createUnderstatReferenceRepository();
export const understatTeamRepository = createUnderstatTeamRepository();
export const understatPlayerRepository = createUnderstatPlayerRepository();
