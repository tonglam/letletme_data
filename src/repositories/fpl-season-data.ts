import { sql } from 'drizzle-orm';

import { getDb, type DbOrTransaction } from '../db/singleton';
import { resolveFplSeasonDataLocation } from './fpl-history';
import { DatabaseError } from '../utils/errors';

export interface FplSeasonTeamRow extends Record<string, unknown> {
  id: number;
  code: number;
  name: string;
}

export interface FplSeasonFixtureRow extends Record<string, unknown> {
  fixtureId: number;
  fixtureCode: number;
  kickoffAt: Date | null;
  finished: boolean;
  homeTeamCode: number;
  awayTeamCode: number;
  homeGoals: number | null;
  awayGoals: number | null;
}

export interface FplSeasonPlayerEvidenceRow extends Record<string, unknown> {
  fixtureCode: number;
  playerCode: number;
  teamCode: number;
  elementType: number;
  minutes: number;
  starts: number | null;
  goals: number;
  assists: number;
  ownGoals: number;
  yellowCards: number;
  redCards: number;
  firstName: string | null;
  secondName: string | null;
  webName: string | null;
}

export interface FplSeasonPlayerRow extends Record<string, unknown> {
  playerCode: number;
  firstName: string | null;
  secondName: string | null;
  webName: string | null;
}

async function getDatabase(dbInstance?: DbOrTransaction): Promise<DbOrTransaction> {
  return dbInstance ?? (await getDb());
}

async function requireLocation(season: string, db: DbOrTransaction) {
  const location = await resolveFplSeasonDataLocation(season, db);
  if (location.kind === 'unavailable') {
    throw new DatabaseError(
      `FPL season ${season} is unavailable: ${location.reason}`,
      'FPL_SEASON_DATA_UNAVAILABLE',
    );
  }
  return location;
}

export const createFplSeasonDataRepository = (dbInstance?: DbOrTransaction) => ({
  async findTeamByCode(season: string, teamCode: number): Promise<FplSeasonTeamRow | null> {
    const db = await getDatabase(dbInstance);
    const location = await requireLocation(season, db);
    const rows =
      location.kind === 'current'
        ? await db.execute<FplSeasonTeamRow>(sql`
            SELECT id, code, name FROM public.teams WHERE code = ${teamCode} LIMIT 1
          `)
        : await db.execute<FplSeasonTeamRow>(sql`
            SELECT id, code, name
            FROM public.teams_history
            WHERE season = ${season} AND code = ${teamCode}
            LIMIT 1
          `);
    return rows[0] ?? null;
  },

  async findFixtures(season: string): Promise<FplSeasonFixtureRow[]> {
    const db = await getDatabase(dbInstance);
    const location = await requireLocation(season, db);
    if (location.kind === 'current') {
      return db.execute<FplSeasonFixtureRow>(sql`
        SELECT
          fixture.id AS "fixtureId",
          fixture.code AS "fixtureCode",
          fixture.kickoff_time AS "kickoffAt",
          fixture.finished,
          home.code AS "homeTeamCode",
          away.code AS "awayTeamCode",
          fixture.team_h_score AS "homeGoals",
          fixture.team_a_score AS "awayGoals"
        FROM public.event_fixtures fixture
        JOIN public.teams home ON home.id = fixture.team_h_id
        JOIN public.teams away ON away.id = fixture.team_a_id
      `);
    }
    return db.execute<FplSeasonFixtureRow>(sql`
      SELECT
        fixture.id AS "fixtureId",
        fixture.code AS "fixtureCode",
        fixture.kickoff_time AS "kickoffAt",
        fixture.finished,
        home.code AS "homeTeamCode",
        away.code AS "awayTeamCode",
        fixture.team_h_score AS "homeGoals",
        fixture.team_a_score AS "awayGoals"
      FROM public.event_fixtures_history fixture
      JOIN public.teams_history home
        ON home.season = fixture.season AND home.id = fixture.team_h_id
      JOIN public.teams_history away
        ON away.season = fixture.season AND away.id = fixture.team_a_id
      WHERE fixture.season = ${season}
    `);
  },

  async findPlayerEvidence(season: string): Promise<FplSeasonPlayerEvidenceRow[]> {
    const db = await getDatabase(dbInstance);
    const location = await requireLocation(season, db);
    if (location.kind === 'current') {
      return db.execute<FplSeasonPlayerEvidenceRow>(sql`
        SELECT
          evidence.fixture_code AS "fixtureCode",
          evidence.player_code AS "playerCode",
          evidence.team_code AS "teamCode",
          evidence.element_type AS "elementType",
          evidence.minutes,
          evidence.starts,
          evidence.goals,
          evidence.assists,
          evidence.own_goals AS "ownGoals",
          evidence.yellow_cards AS "yellowCards",
          evidence.red_cards AS "redCards",
          player.first_name AS "firstName",
          player.second_name AS "secondName",
          player.web_name AS "webName"
        FROM public.fpl_player_fixture_stats evidence
        LEFT JOIN public.players player ON player.code = evidence.player_code
        WHERE evidence.season = ${season}
      `);
    }
    return db.execute<FplSeasonPlayerEvidenceRow>(sql`
      SELECT
        evidence.fixture_code AS "fixtureCode",
        evidence.player_code AS "playerCode",
        evidence.team_code AS "teamCode",
        evidence.element_type AS "elementType",
        evidence.minutes,
        evidence.starts,
        evidence.goals,
        evidence.assists,
        evidence.own_goals AS "ownGoals",
        evidence.yellow_cards AS "yellowCards",
        evidence.red_cards AS "redCards",
        player.first_name AS "firstName",
        player.second_name AS "secondName",
        player.web_name AS "webName"
        FROM public.fpl_player_fixture_stats_history evidence
        LEFT JOIN public.players_history player
        ON player.season = evidence.season AND player.code = evidence.player_code
      WHERE evidence.season = ${season}
    `);
  },

  async findPlayers(season: string): Promise<FplSeasonPlayerRow[]> {
    const db = await getDatabase(dbInstance);
    const location = await requireLocation(season, db);
    if (location.kind === 'current') {
      return db.execute<FplSeasonPlayerRow>(sql`
        SELECT
          code AS "playerCode",
          first_name AS "firstName",
          second_name AS "secondName",
          web_name AS "webName"
        FROM public.players
      `);
    }
    return db.execute<FplSeasonPlayerRow>(sql`
      SELECT
        code AS "playerCode",
        first_name AS "firstName",
        second_name AS "secondName",
        web_name AS "webName"
      FROM public.players_history
      WHERE season = ${season}
    `);
  },
});

export const fplSeasonDataRepository = createFplSeasonDataRepository();
