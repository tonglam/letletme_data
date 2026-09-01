// Canonical fpl PostgreSQL schema declarations.
import {
  foreignKey,
  unique,
  check,
  smallint,
  text,
  jsonb,
  timestamp,
  index,
  integer,
  boolean,
  uniqueIndex,
  bigint,
  date,
  numeric,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fpl } from './namespaces.schema';

export const playerMarketSnapshotSourceIdsInFpl = fpl.sequence(
  'player_market_snapshots_source_snapshot_id_seq',
  {
    startWith: '1',
    increment: '1',
    minValue: '1',
    maxValue: '9223372036854775807',
    cache: '1',
    cycle: false,
  },
);

export const playerEventSnapshotPublicationRevisionsInFpl = fpl.sequence(
  'player_event_snapshot_publication_revision_seq',
  {
    startWith: '1',
    increment: '1',
    minValue: '1',
    maxValue: '9223372036854775807',
    cache: '1',
    cycle: false,
  },
);

export const seasonsInFpl = fpl.table(
  'seasons',
  {
    seasonId: smallint('season_id').primaryKey().notNull(),
    seasonCode: text('season_code').notNull(),
    displayName: text('display_name').notNull(),
    startYear: smallint('start_year').notNull(),
    endYear: smallint('end_year').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    isCurrent: boolean('is_current').default(false).notNull(),
    startsAt: date('starts_at'),
    endsAt: date('ends_at'),
    sourceMetadata: jsonb('source_metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('seasons_one_current_idx')
      .using('btree', table.isCurrent.asc().nullsLast())
      .where(sql`is_current`),
    unique('seasons_season_code_key').on(table.seasonCode),
    unique('seasons_display_name_key').on(table.displayName),
    unique('seasons_start_year_key').on(table.startYear),
    unique('seasons_end_year_key').on(table.endYear),
    check('seasons_id_is_start_year', sql`season_id = start_year`),
    check('seasons_code_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check('seasons_year_span', sql`end_year = (start_year + 1)`),
    check(
      'seasons_lifecycle_state_valid',
      sql`lifecycle_state = ANY (ARRAY['reference_only'::text, 'completed'::text, 'preseason'::text, 'active'::text, 'closed'::text])`,
    ),
    check(
      'seasons_date_order',
      sql`(ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at)`,
    ),
    check('seasons_source_metadata_object', sql`jsonb_typeof(source_metadata) = 'object'::text`),
  ],
);

export const phasesInFpl = fpl.table(
  'phases',
  {
    seasonId: smallint('season_id').notNull(),
    phaseId: integer('phase_id').notNull(),
    name: text().notNull(),
    startEvent: integer('start_event').notNull(),
    stopEvent: integer('stop_event').notNull(),
    highestScore: integer('highest_score'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('phases_event_range_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.startEvent.asc().nullsLast(),
      table.stopEvent.asc().nullsLast(),
    ),
    index('phases_stop_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.stopEvent.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'phases_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.startEvent],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'phases_start_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.stopEvent],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'phases_stop_event_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.phaseId], name: 'phases_pkey' }),
    check('phases_phase_id_positive', sql`phase_id > 0`),
    check('phases_event_range', sql`(start_event > 0) AND (stop_event >= start_event)`),
    check('phases_highest_score_nonnegative', sql`(highest_score IS NULL) OR (highest_score >= 0)`),
    check('phases_name_nonempty', sql`btrim(name) <> ''::text`),
  ],
);

export const playerGameweekScoringItemsInFpl = fpl.table(
  'player_gameweek_scoring_items',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    elementId: integer('element_id').notNull(),
    scoringIdentifier: text('scoring_identifier').notNull(),
    scoringValue: integer('scoring_value').notNull(),
    points: integer().notNull(),
    sourceExplainId: integer('source_explain_id')
      .generatedByDefaultAsIdentity({
        name: 'player_gameweek_scoring_items_source_explain_id_seq',
      })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_gameweek_scoring_items_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('player_gameweek_scoring_items_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceExplainId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_gameweek_scoring_items_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId, table.elementId],
      foreignColumns: [
        playerGameweekStatsInFpl.seasonId,
        playerGameweekStatsInFpl.eventId,
        playerGameweekStatsInFpl.elementId,
      ],
      name: 'player_scoring_gameweek_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.elementId, table.scoringIdentifier],
      name: 'player_gameweek_scoring_items_pkey',
    }),
    check(
      'player_gameweek_scoring_items_ids_positive',
      sql`(event_id > 0) AND (element_id > 0) AND (source_explain_id > 0)`,
    ),
    check(
      'player_gameweek_scoring_items_identifier_valid',
      sql`scoring_identifier = ANY (ARRAY['minutes'::text, 'goals_scored'::text, 'assists'::text, 'clean_sheets'::text, 'goals_conceded'::text, 'own_goals'::text, 'penalties_saved'::text, 'penalties_missed'::text, 'yellow_cards'::text, 'red_cards'::text, 'saves'::text, 'bonus'::text, 'defensive_contribution'::text])`,
    ),
  ],
);

export const playersInFpl = fpl.table(
  'players',
  {
    seasonId: smallint('season_id').notNull(),
    elementId: integer('element_id').notNull(),
    code: integer().notNull(),
    elementType: integer('element_type').notNull(),
    teamId: integer('team_id').notNull(),
    price: integer().default(0).notNull(),
    startPrice: integer('start_price').default(0).notNull(),
    firstName: text('first_name'),
    secondName: text('second_name'),
    webName: text('web_name').notNull(),
    totalPoints: integer('total_points').default(0).notNull(),
    priceSourceCheckedAt: timestamp('price_source_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    isActive: boolean('is_active').default(true).notNull(),
  },
  (table) => [
    index('players_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamId.asc().nullsLast(),
    ),
    index('players_type_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementType.asc().nullsLast(),
    ),
    index('players_active_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.isActive.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('players_web_name_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.webName.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'players_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'players_team_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.elementId], name: 'players_pkey' }),
    unique('players_season_code_unique').on(table.seasonId, table.code),
    check('players_element_id_positive', sql`element_id > 0`),
    check('players_code_positive', sql`code > 0`),
    check('players_element_type_positive', sql`element_type > 0`),
    check('players_prices_nonnegative', sql`(price >= 0) AND (start_price >= 0)`),
    check('players_web_name_nonempty', sql`btrim(web_name) <> ''::text`),
  ],
);

export const playerFixtureStatsInFpl = fpl.table(
  'player_fixture_stats',
  {
    seasonId: smallint('season_id').notNull(),
    fixtureId: integer('fixture_id').notNull(),
    elementId: integer('element_id').notNull(),
    sourceFixtureStatId: integer('source_fixture_stat_id')
      .generatedByDefaultAsIdentity({ name: 'player_fixture_stats_source_fixture_stat_id_seq' })
      .notNull(),
    eventId: integer('event_id').notNull(),
    fixtureCode: integer('fixture_code').notNull(),
    playerCode: integer('player_code').notNull(),
    teamId: integer('team_id').notNull(),
    teamCode: integer('team_code').notNull(),
    elementType: integer('element_type').notNull(),
    minutes: integer().notNull(),
    starts: integer(),
    goals: integer().notNull(),
    assists: integer().notNull(),
    ownGoals: integer('own_goals').notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_fixture_stats_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('player_fixture_stats_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    uniqueIndex('player_fixture_stats_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceFixtureStatId.asc().nullsLast(),
    ),
    index('player_fixture_stats_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_fixture_stats_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_fixture_stats_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.fixtureId],
      foreignColumns: [fixturesInFpl.seasonId, fixturesInFpl.fixtureId],
      name: 'player_fixture_stats_fixture_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_fixture_stats_player_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'player_fixture_stats_team_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.fixtureId, table.elementId],
      name: 'player_fixture_stats_pkey',
    }),
    check(
      'player_fixture_stats_counts_nonnegative',
      sql`(minutes >= 0) AND ((starts IS NULL) OR (starts >= 0)) AND (goals >= 0) AND (assists >= 0) AND (own_goals >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0)`,
    ),
    check(
      'player_fixture_stats_ids_positive',
      sql`(fixture_id > 0) AND (element_id > 0) AND (source_fixture_stat_id > 0) AND (event_id > 0) AND (fixture_code > 0) AND (player_code > 0) AND (team_id > 0) AND (team_code > 0) AND (element_type > 0)`,
    ),
    check('player_fixture_stats_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const fixturesInFpl = fpl.table(
  'fixtures',
  {
    seasonId: smallint('season_id').notNull(),
    fixtureId: integer('fixture_id').notNull(),
    code: integer().notNull(),
    eventId: integer('event_id'),
    kickoffTime: timestamp('kickoff_time', { withTimezone: true, mode: 'date' }),
    started: boolean().default(false).notNull(),
    finished: boolean().default(false).notNull(),
    finishedProvisional: boolean('finished_provisional').default(false).notNull(),
    provisionalStartTime: boolean('provisional_start_time').default(false).notNull(),
    minutes: integer().default(0).notNull(),
    teamHId: integer('team_h_id'),
    teamHDifficulty: integer('team_h_difficulty'),
    teamHScore: integer('team_h_score'),
    teamAId: integer('team_a_id'),
    teamADifficulty: integer('team_a_difficulty'),
    teamAScore: integer('team_a_score'),
    stats: jsonb().default([]).notNull(),
    pulseId: integer('pulse_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('fixtures_away_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamAId.asc().nullsLast(),
    ),
    index('fixtures_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('fixtures_home_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamHId.asc().nullsLast(),
    ),
    index('fixtures_kickoff_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.kickoffTime.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'fixtures_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamAId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'fixtures_away_team_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'fixtures_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamHId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'fixtures_home_team_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.fixtureId], name: 'fixtures_pkey' }),
    unique('fixtures_season_code_unique').on(table.seasonId, table.code),
    check('fixtures_fixture_id_positive', sql`fixture_id > 0`),
    check('fixtures_code_positive', sql`code > 0`),
    check('fixtures_event_positive', sql`(event_id IS NULL) OR (event_id > 0)`),
    check('fixtures_minutes_valid', sql`(minutes >= 0) AND (minutes <= 180)`),
    check(
      'fixtures_distinct_teams',
      sql`(team_h_id IS NULL) OR (team_a_id IS NULL) OR (team_h_id <> team_a_id)`,
    ),
    check(
      'fixtures_scores_nonnegative',
      sql`((team_h_score IS NULL) OR (team_h_score >= 0)) AND ((team_a_score IS NULL) OR (team_a_score >= 0))`,
    ),
    check(
      'fixtures_difficulty_valid',
      sql`((team_h_difficulty IS NULL) OR ((team_h_difficulty >= 0) AND (team_h_difficulty <= 5))) AND ((team_a_difficulty IS NULL) OR ((team_a_difficulty >= 0) AND (team_a_difficulty <= 5)))`,
    ),
    check('fixtures_stats_array', sql`jsonb_typeof(stats) = 'array'::text`),
  ],
);

export const teamsInFpl = fpl.table(
  'teams',
  {
    seasonId: smallint('season_id').notNull(),
    teamId: integer('team_id').notNull(),
    code: integer().notNull(),
    name: text().notNull(),
    shortName: text('short_name').notNull(),
    strength: integer(),
    position: integer().default(0).notNull(),
    points: integer().default(0).notNull(),
    win: integer().default(0).notNull(),
    draw: integer().default(0).notNull(),
    loss: integer().default(0).notNull(),
    played: integer().default(0).notNull(),
    form: text(),
    teamDivision: integer('team_division'),
    unavailable: boolean().default(false).notNull(),
    strengthOverallHome: integer('strength_overall_home').default(1000).notNull(),
    strengthOverallAway: integer('strength_overall_away').default(1000).notNull(),
    strengthAttackHome: integer('strength_attack_home').default(1000).notNull(),
    strengthAttackAway: integer('strength_attack_away').default(1000).notNull(),
    strengthDefenceHome: integer('strength_defence_home').default(1000).notNull(),
    strengthDefenceAway: integer('strength_defence_away').default(1000).notNull(),
    pulseId: integer('pulse_id').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('teams_season_name_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.name.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'teams_season_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.teamId], name: 'teams_pkey' }),
    unique('teams_season_code_unique').on(table.seasonId, table.code),
    check('teams_team_id_positive', sql`team_id > 0`),
    check('teams_code_positive', sql`code > 0`),
    check(
      'teams_record_nonnegative',
      sql`("position" >= 0) AND (win >= 0) AND (draw >= 0) AND (loss >= 0) AND (played >= 0)`,
    ),
    check(
      'teams_names_nonempty',
      sql`(btrim(name) <> ''::text) AND (btrim(short_name) <> ''::text)`,
    ),
  ],
);

export const playerGameweekStatsInFpl = fpl.table(
  'player_gameweek_stats',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    elementId: integer('element_id').notNull(),
    sourceLiveId: integer('source_live_id')
      .generatedByDefaultAsIdentity({ name: 'player_gameweek_stats_source_live_id_seq' })
      .notNull(),
    minutes: integer(),
    goalsScored: integer('goals_scored'),
    assists: integer(),
    cleanSheets: integer('clean_sheets'),
    goalsConceded: integer('goals_conceded'),
    ownGoals: integer('own_goals'),
    penaltiesSaved: integer('penalties_saved'),
    penaltiesMissed: integer('penalties_missed'),
    yellowCards: integer('yellow_cards'),
    redCards: integer('red_cards'),
    saves: integer(),
    bonus: integer(),
    bps: integer(),
    starts: boolean(),
    expectedGoals: numeric('expected_goals'),
    expectedAssists: numeric('expected_assists'),
    expectedGoalInvolvements: numeric('expected_goal_involvements'),
    expectedGoalsConceded: numeric('expected_goals_conceded'),
    inDreamTeam: boolean('in_dream_team'),
    totalPoints: integer('total_points').default(0).notNull(),
    defensiveContribution: integer('defensive_contribution').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_gameweek_stats_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    uniqueIndex('player_gameweek_stats_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceLiveId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_gameweek_stats_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_gameweek_stats_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_gameweek_stats_player_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.elementId],
      name: 'player_gameweek_stats_pkey',
    }),
    check(
      'player_gameweek_stats_ids_positive',
      sql`(event_id > 0) AND (element_id > 0) AND (source_live_id > 0)`,
    ),
    check('player_gameweek_stats_minutes_nonnegative', sql`(minutes IS NULL) OR (minutes >= 0)`),
  ],
);

export const eventsInFpl = fpl.table(
  'events',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    name: text().notNull(),
    deadlineTime: timestamp('deadline_time', { withTimezone: true, mode: 'string' }),
    averageEntryScore: integer('average_entry_score'),
    finished: boolean().default(false).notNull(),
    dataChecked: boolean('data_checked').default(false).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    highestScoringEntry: bigint('highest_scoring_entry', { mode: 'number' }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    deadlineTimeEpoch: bigint('deadline_time_epoch', { mode: 'number' }),
    deadlineTimeGameOffset: integer('deadline_time_game_offset'),
    highestScore: integer('highest_score'),
    isPrevious: boolean('is_previous').default(false).notNull(),
    isCurrent: boolean('is_current').default(false).notNull(),
    isNext: boolean('is_next').default(false).notNull(),
    cupLeagueCreate: boolean('cup_league_create').default(false).notNull(),
    h2HKoMatchesCreated: boolean('h2h_ko_matches_created').default(false).notNull(),
    chipPlays: jsonb('chip_plays').default([]).notNull(),
    mostSelected: integer('most_selected'),
    mostTransferredIn: integer('most_transferred_in'),
    topElement: integer('top_element'),
    topElementInfo: jsonb('top_element_info'),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    transfersMade: bigint('transfers_made', { mode: 'number' }),
    mostCaptained: integer('most_captained'),
    mostViceCaptained: integer('most_vice_captained'),
    liveSnapshotCheckedAt: timestamp('live_snapshot_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    liveSnapshotFinalizedAt: timestamp('live_snapshot_finalized_at', {
      withTimezone: true,
      mode: 'date',
    }),
    dataCheckedAt: timestamp('data_checked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    liveFactsPersistedAt: timestamp('live_facts_persisted_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    index('events_current_flags_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.isCurrent.asc().nullsLast(),
      table.isNext.asc().nullsLast(),
      table.isPrevious.asc().nullsLast(),
    ),
    index('events_deadline_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.deadlineTime.asc().nullsLast(),
    ),
    index('events_most_captained_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostCaptained.asc().nullsLast(),
    ),
    index('events_most_selected_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostSelected.asc().nullsLast(),
    ),
    index('events_most_transferred_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostTransferredIn.asc().nullsLast(),
    ),
    index('events_most_vice_captained_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostViceCaptained.asc().nullsLast(),
    ),
    index('events_top_element_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.topElement.asc().nullsLast(),
    ),
    index('events_top_element_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.topElement.asc().nullsLast())
      .where(sql`(top_element IS NOT NULL)`),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'events_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostCaptained],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_captained_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostSelected],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_selected_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostTransferredIn],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_transferred_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostViceCaptained],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_vice_captained_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.topElement],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_top_element_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.eventId], name: 'events_pkey' }),
    check('events_event_id_positive', sql`event_id > 0`),
    check(
      'events_scores_nonnegative',
      sql`((average_entry_score IS NULL) OR (average_entry_score >= 0)) AND ((highest_score IS NULL) OR (highest_score >= 0))`,
    ),
    check('events_chip_plays_array', sql`jsonb_typeof(chip_plays) = 'array'::text`),
    check(
      'events_finalization_order',
      sql`(live_snapshot_finalized_at IS NULL) OR (live_snapshot_checked_at IS NULL) OR (live_snapshot_finalized_at >= live_snapshot_checked_at)`,
    ),
  ],
);

export const playerEventSnapshotsInFpl = fpl.table(
  'player_event_snapshots',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    elementId: integer('element_id').notNull(),
    sourceSnapshotId: integer('source_snapshot_id')
      .generatedByDefaultAsIdentity({ name: 'player_event_snapshots_source_snapshot_id_seq' })
      .notNull(),
    elementType: integer('element_type').notNull(),
    totalPoints: integer('total_points'),
    form: numeric(),
    influence: numeric(),
    creativity: numeric(),
    threat: numeric(),
    ictIndex: numeric('ict_index'),
    expectedGoals: numeric('expected_goals'),
    expectedAssists: numeric('expected_assists'),
    expectedGoalInvolvements: numeric('expected_goal_involvements'),
    expectedGoalsConceded: numeric('expected_goals_conceded'),
    minutes: integer(),
    goalsScored: integer('goals_scored'),
    assists: integer(),
    cleanSheets: integer('clean_sheets'),
    goalsConceded: integer('goals_conceded'),
    ownGoals: integer('own_goals'),
    penaltiesSaved: integer('penalties_saved'),
    yellowCards: integer('yellow_cards'),
    redCards: integer('red_cards'),
    saves: integer(),
    bonus: integer(),
    bps: integer(),
    starts: integer(),
    influenceRank: integer('influence_rank'),
    influenceRankType: integer('influence_rank_type'),
    creativityRank: integer('creativity_rank'),
    creativityRankType: integer('creativity_rank_type'),
    threatRank: integer('threat_rank'),
    threatRankType: integer('threat_rank_type'),
    ictIndexRank: integer('ict_index_rank'),
    ictIndexRankType: integer('ict_index_rank_type'),
    transfersIn: integer('transfers_in'),
    transfersInEvent: integer('transfers_in_event'),
    transfersOut: integer('transfers_out'),
    transfersOutEvent: integer('transfers_out_event'),
    selectedByPercent: numeric('selected_by_percent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_event_snapshots_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    uniqueIndex('player_event_snapshots_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceSnapshotId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_event_snapshots_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_event_snapshots_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_event_snapshots_player_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.elementId],
      name: 'player_event_snapshots_pkey',
    }),
    check(
      'player_event_snapshots_ids_positive',
      sql`(event_id > 0) AND (element_id > 0) AND (source_snapshot_id > 0) AND (element_type > 0)`,
    ),
    check('player_event_snapshots_minutes_nonnegative', sql`(minutes IS NULL) OR (minutes >= 0)`),
    check(
      'player_event_snapshots_selected_percent',
      sql`(selected_by_percent IS NULL) OR ((selected_by_percent >= (0)::numeric) AND (selected_by_percent <= (100)::numeric))`,
    ),
  ],
);

export const playerEventSnapshotPublicationsInFpl = fpl.table(
  'player_event_snapshot_publications',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint('revision', { mode: 'number' })
      .default(sql`nextval('fpl.player_event_snapshot_publication_revision_seq'::regclass)`)
      .notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    rowCount: integer('row_count').notNull(),
    expectedRowCount: integer('expected_row_count').notNull(),
    contentSha256: text('content_sha256').notNull(),
    baselineVerifiedAt: timestamp('baseline_verified_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_event_snapshot_publications_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_event_snapshot_publications_event_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId],
      name: 'player_event_snapshot_publications_pkey',
    }),
    check('player_event_snapshot_publications_revision_positive', sql`revision > 0`),
    check(
      'player_event_snapshot_publications_counts_positive',
      sql`row_count > 0 AND expected_row_count > 0`,
    ),
    check(
      'player_event_snapshot_publications_counts_complete',
      sql`row_count = expected_row_count`,
    ),
    check(
      'player_event_snapshot_publications_hash_valid',
      sql`content_sha256 ~ '^[0-9a-f]{64}$'::text`,
    ),
  ],
);

/** Redis-first Live Matches V3 compact desk checkpoint. */
export const liveMatchDeskCheckpointsInFpl = fpl.table(
  'live_match_desk_checkpoints',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    publicationId: text('publication_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    state: text().notNull(),
    manifest: jsonb().notNull(),
    revisions: jsonb().notNull(),
    payload: jsonb().notNull(),
    rowCount: integer('row_count').notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
    checkpointedAt: timestamp('checkpointed_at', { withTimezone: true, mode: 'date' }).notNull(),
    expectedNextCheckAt: timestamp('expected_next_check_at', { withTimezone: true, mode: 'date' }),
    staleAt: timestamp('stale_at', { withTimezone: true, mode: 'date' }),
    contractVersion: text('contract_version').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.eventId],
      name: 'live_match_desk_checkpoints_pkey',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'live_match_desk_checkpoints_event_fk',
    }),
    unique('live_match_desk_checkpoints_publication_once').on(
      table.seasonId,
      table.eventId,
      table.publicationId,
    ),
    index('live_match_desk_checkpoints_generation_idx').on(
      table.seasonId,
      table.eventId,
      table.generation,
    ),
    check(
      'live_match_desk_checkpoints_identity_valid',
      sql`event_id > 0 AND generation > 0 AND publication_id ~ '^[0-9a-f-]{36}$' AND state = ANY (ARRAY['PRE_DEADLINE','LIVE_ACTIVE','BETWEEN_FIXTURES','DAY_SETTLING','GW_REVIEW','FINALIZED']::text[])`,
    ),
    check(
      'live_match_desk_checkpoints_payload_valid',
      sql`jsonb_typeof(manifest) = 'object' AND pg_column_size(manifest) <= 131072 AND jsonb_typeof(revisions) = 'object' AND jsonb_typeof(payload) = 'array' AND row_count = jsonb_array_length(payload) AND row_count BETWEEN 0 AND 32 AND payload_bytes BETWEEN 0 AND 131072 AND payload_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** Redis-first Live Matches V3 compact fixture-detail checkpoint. */
export const liveMatchDetailCheckpointsInFpl = fpl.table(
  'live_match_detail_checkpoints',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    publicationId: text('publication_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    state: text().notNull(),
    observedDeskGeneration: bigint('observed_desk_generation', { mode: 'number' }).notNull(),
    fixtureIdentityRevision: text('fixture_identity_revision').notNull(),
    manifest: jsonb().notNull(),
    revisions: jsonb().notNull(),
    payload: jsonb().notNull(),
    rowCount: integer('row_count').notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
    checkpointedAt: timestamp('checkpointed_at', { withTimezone: true, mode: 'date' }).notNull(),
    expectedNextCheckAt: timestamp('expected_next_check_at', { withTimezone: true, mode: 'date' }),
    staleAt: timestamp('stale_at', { withTimezone: true, mode: 'date' }),
    contractVersion: text('contract_version').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.eventId],
      name: 'live_match_detail_checkpoints_pkey',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'live_match_detail_checkpoints_event_fk',
    }),
    unique('live_match_detail_checkpoints_publication_once').on(
      table.seasonId,
      table.eventId,
      table.publicationId,
    ),
    index('live_match_detail_checkpoints_generation_idx').on(
      table.seasonId,
      table.eventId,
      table.generation,
    ),
    check(
      'live_match_detail_checkpoints_identity_valid',
      sql`event_id > 0 AND generation > 0 AND observed_desk_generation > 0 AND publication_id ~ '^[0-9a-f-]{36}$' AND fixture_identity_revision ~ '^[0-9a-f]{64}$' AND state = ANY (ARRAY['PROVISIONAL','FINALIZED']::text[])`,
    ),
    check(
      'live_match_detail_checkpoints_payload_valid',
      sql`jsonb_typeof(manifest) = 'object' AND pg_column_size(manifest) <= 131072 AND jsonb_typeof(revisions) = 'object' AND jsonb_typeof(payload) = 'array' AND row_count = jsonb_array_length(payload) AND row_count BETWEEN 0 AND 32 AND payload_bytes BETWEEN 0 AND 2097152 AND payload_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);
