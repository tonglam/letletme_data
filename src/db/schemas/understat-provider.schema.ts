import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { timestamps } from './_helpers.schema';
import { understatSeasonStateEnum } from './enums.schema';

const metric = (name: string) => numeric(name, { precision: 14, scale: 8, mode: 'number' });
const probability = (name: string) => numeric(name, { precision: 10, scale: 8, mode: 'number' });

export const understatSeasons = pgTable(
  'understat_seasons',
  {
    season: text('season').primaryKey(),
    sourceYear: integer('source_year').notNull(),
    league: text('league').notNull(),
    state: understatSeasonStateEnum('state').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_understat_seasons_league_year').on(table.league, table.sourceYear),
    check('understat_seasons_key_check', sql`${table.season} ~ '^[0-9]{4}$'`),
  ],
);

export const understatTeams = pgTable(
  'understat_teams',
  {
    id: integer('id').primaryKey(),
    title: text('title').notNull(),
    shortTitle: text('short_title'),
    firstSeenSeason: text('first_seen_season')
      .notNull()
      .references(() => understatSeasons.season),
    lastSeenSeason: text('last_seen_season')
      .notNull()
      .references(() => understatSeasons.season),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [index('idx_understat_teams_last_seen_season').on(table.lastSeenSeason)],
);

export const understatMatches = pgTable(
  'understat_matches',
  {
    id: integer('id').primaryKey(),
    season: text('season')
      .notNull()
      .references(() => understatSeasons.season),
    homeTeamId: integer('home_team_id')
      .notNull()
      .references(() => understatTeams.id),
    awayTeamId: integer('away_team_id')
      .notNull()
      .references(() => understatTeams.id),
    kickoffAt: timestamp('kickoff_at', { withTimezone: true }).notNull(),
    isResult: boolean('is_result').default(false).notNull(),
    homeGoals: integer('home_goals'),
    awayGoals: integer('away_goals'),
    homeXg: metric('home_xg'),
    awayXg: metric('away_xg'),
    forecastHomeWin: probability('forecast_home_win'),
    forecastDraw: probability('forecast_draw'),
    forecastAwayWin: probability('forecast_away_win'),
    sourceHash: text('source_hash').notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_understat_matches_identity').on(
      table.season,
      table.homeTeamId,
      table.awayTeamId,
      table.kickoffAt,
    ),
    index('idx_understat_matches_season_kickoff').on(table.season, table.kickoffAt),
    index('idx_understat_matches_home_team').on(table.homeTeamId),
    index('idx_understat_matches_away_team').on(table.awayTeamId),
    check(
      'understat_matches_distinct_teams_check',
      sql`${table.homeTeamId} <> ${table.awayTeamId}`,
    ),
  ],
);

export const understatTeamMatchStats = pgTable(
  'understat_team_match_stats',
  {
    matchId: integer('match_id')
      .notNull()
      .references(() => understatMatches.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => understatTeams.id),
    side: text('side').notNull(),
    xg: metric('xg').notNull(),
    xga: metric('xga').notNull(),
    npxg: metric('npxg').notNull(),
    npxga: metric('npxga').notNull(),
    npxgd: metric('npxgd').notNull(),
    ppdaAtt: integer('ppda_att').notNull(),
    ppdaDef: integer('ppda_def').notNull(),
    ppdaAllowedAtt: integer('ppda_allowed_att').notNull(),
    ppdaAllowedDef: integer('ppda_allowed_def').notNull(),
    deep: integer('deep').notNull(),
    deepAllowed: integer('deep_allowed').notNull(),
    scored: integer('scored').notNull(),
    missed: integer('missed').notNull(),
    xpoints: metric('xpoints').notNull(),
    result: text('result').notNull(),
    points: integer('points').notNull(),
    wins: integer('wins').notNull(),
    draws: integer('draws').notNull(),
    losses: integer('losses').notNull(),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.matchId, table.teamId] }),
    index('idx_understat_team_match_stats_team').on(table.teamId, table.matchId),
    check('understat_team_match_stats_side_check', sql`${table.side} IN ('h', 'a')`),
    check('understat_team_match_stats_result_check', sql`${table.result} IN ('w', 'd', 'l')`),
  ],
);

export const understatTeamSeasons = pgTable(
  'understat_team_seasons',
  {
    season: text('season')
      .notNull()
      .references(() => understatSeasons.season),
    teamId: integer('team_id')
      .notNull()
      .references(() => understatTeams.id),
    sourceTitle: text('source_title').notNull(),
    sourceShortTitle: text('source_short_title'),
    games: integer('games').notNull(),
    wins: integer('wins').notNull(),
    draws: integer('draws').notNull(),
    losses: integer('losses').notNull(),
    goalsFor: integer('goals_for').notNull(),
    goalsAgainst: integer('goals_against').notNull(),
    points: integer('points').notNull(),
    xg: metric('xg').notNull(),
    xga: metric('xga').notNull(),
    npxg: metric('npxg').notNull(),
    npxga: metric('npxga').notNull(),
    npxgd: metric('npxgd').notNull(),
    xpoints: metric('xpoints').notNull(),
    deep: integer('deep').notNull(),
    deepAllowed: integer('deep_allowed').notNull(),
    ppdaAtt: integer('ppda_att').notNull(),
    ppdaDef: integer('ppda_def').notNull(),
    ppdaAllowedAtt: integer('ppda_allowed_att').notNull(),
    ppdaAllowedDef: integer('ppda_allowed_def').notNull(),
    sourceHash: text('source_hash').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.season, table.teamId] })],
);

export const understatTeamStatSplits = pgTable(
  'understat_team_stat_splits',
  {
    season: text('season')
      .notNull()
      .references(() => understatSeasons.season),
    teamId: integer('team_id')
      .notNull()
      .references(() => understatTeams.id),
    dimension: text('dimension').notNull(),
    splitKey: text('split_key').notNull(),
    label: text('label'),
    timeMinutes: integer('time_minutes'),
    shotsFor: integer('shots_for').notNull(),
    goalsFor: integer('goals_for').notNull(),
    xgFor: metric('xg_for').notNull(),
    shotsAgainst: integer('shots_against').notNull(),
    goalsAgainst: integer('goals_against').notNull(),
    xgAgainst: metric('xg_against').notNull(),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.season, table.teamId, table.dimension, table.splitKey] }),
    index('idx_understat_team_stat_splits_team').on(table.season, table.teamId),
    check(
      'understat_team_stat_splits_dimension_check',
      sql`${table.dimension} IN ('situation','formation','gameState','timing','shotZone','attackSpeed','result')`,
    ),
  ],
);

export const understatPlayers = pgTable(
  'understat_players',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    favoritePosition: text('favorite_position'),
    firstSeenSeason: text('first_seen_season')
      .notNull()
      .references(() => understatSeasons.season),
    lastSeenSeason: text('last_seen_season')
      .notNull()
      .references(() => understatSeasons.season),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [index('idx_understat_players_last_seen_season').on(table.lastSeenSeason)],
);

const playerSeasonFields = () => ({
  games: integer('games').notNull(),
  time: integer('time').notNull(),
  goals: integer('goals').notNull(),
  npg: integer('npg').notNull(),
  assists: integer('assists').notNull(),
  shots: integer('shots').notNull(),
  keyPasses: integer('key_passes').notNull(),
  yellowCards: integer('yellow_cards').notNull(),
  redCards: integer('red_cards').notNull(),
  xg: metric('xg').notNull(),
  npxg: metric('npxg').notNull(),
  xa: metric('xa').notNull(),
  xgChain: metric('xg_chain').notNull(),
  xgBuildup: metric('xg_buildup').notNull(),
  position: text('position').notNull(),
});

export const understatPlayerSeasons = pgTable(
  'understat_player_seasons',
  {
    season: text('season')
      .notNull()
      .references(() => understatSeasons.season),
    playerId: integer('player_id')
      .notNull()
      .references(() => understatPlayers.id),
    sourceName: text('source_name').notNull(),
    sourceTeamTitle: text('source_team_title').notNull(),
    ...playerSeasonFields(),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.season, table.playerId] }),
    index('idx_understat_player_seasons_season').on(table.season),
  ],
);

export const understatPlayerTeamSeasons = pgTable(
  'understat_player_team_seasons',
  {
    season: text('season')
      .notNull()
      .references(() => understatSeasons.season),
    playerId: integer('player_id')
      .notNull()
      .references(() => understatPlayers.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => understatTeams.id),
    ...playerSeasonFields(),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.season, table.playerId, table.teamId] }),
    index('idx_understat_player_team_seasons_team').on(table.season, table.teamId),
  ],
);

export const understatPlayerMatchStats = pgTable(
  'understat_player_match_stats',
  {
    rosterId: integer('roster_id').primaryKey(),
    matchId: integer('match_id')
      .notNull()
      .references(() => understatMatches.id),
    playerId: integer('player_id')
      .notNull()
      .references(() => understatPlayers.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => understatTeams.id),
    playerName: text('player_name').notNull(),
    side: text('side').notNull(),
    position: text('position').notNull(),
    positionOrder: integer('position_order').notNull(),
    minutes: integer('minutes').notNull(),
    started: boolean('started').notNull(),
    goals: integer('goals').notNull(),
    ownGoals: integer('own_goals').notNull(),
    shots: integer('shots').notNull(),
    keyPasses: integer('key_passes').notNull(),
    assists: integer('assists').notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    xg: metric('xg').notNull(),
    xa: metric('xa').notNull(),
    xgChain: metric('xg_chain').notNull(),
    xgBuildup: metric('xg_buildup').notNull(),
    rosterInId: integer('roster_in_id'),
    rosterOutId: integer('roster_out_id'),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('uq_understat_player_match_stats_identity').on(
      table.matchId,
      table.playerId,
      table.teamId,
    ),
    index('idx_understat_player_match_stats_player').on(table.playerId, table.matchId),
    index('idx_understat_player_match_stats_team').on(table.teamId, table.matchId),
    check('understat_player_match_stats_side_check', sql`${table.side} IN ('h', 'a')`),
    check('understat_player_match_stats_minutes_check', sql`${table.minutes} >= 0`),
  ],
);

export type DbUnderstatSeason = typeof understatSeasons.$inferSelect;
export type DbUnderstatTeam = typeof understatTeams.$inferSelect;
export type DbUnderstatMatch = typeof understatMatches.$inferSelect;
export type DbUnderstatTeamMatchStat = typeof understatTeamMatchStats.$inferSelect;
export type DbUnderstatTeamSeason = typeof understatTeamSeasons.$inferSelect;
export type DbUnderstatTeamStatSplit = typeof understatTeamStatSplits.$inferSelect;
export type DbUnderstatPlayer = typeof understatPlayers.$inferSelect;
export type DbUnderstatPlayerSeason = typeof understatPlayerSeasons.$inferSelect;
export type DbUnderstatPlayerTeamSeason = typeof understatPlayerTeamSeasons.$inferSelect;
export type DbUnderstatPlayerMatchStat = typeof understatPlayerMatchStats.$inferSelect;
