import { sql } from 'drizzle-orm';

import { getDb, type DbOrTransaction } from '../db/singleton';
import { createSeasonRepository } from './seasons';

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

async function requireSeasonId(season: string, db: DbOrTransaction): Promise<number> {
  return (await createSeasonRepository(db).requireByCode(season)).seasonId;
}

export const createFplSeasonDataRepository = (dbInstance?: DbOrTransaction) => ({
  async findTeamByCode(season: string, teamCode: number): Promise<FplSeasonTeamRow | null> {
    const db = await getDatabase(dbInstance);
    const seasonId = await requireSeasonId(season, db);
    const rows = await db.execute<FplSeasonTeamRow>(sql`
      SELECT team_id AS id, code, name
      FROM fpl.teams
      WHERE season_id = ${seasonId} AND code = ${teamCode}
      LIMIT 1
    `);
    return rows[0] ?? null;
  },

  async findFixtures(season: string): Promise<FplSeasonFixtureRow[]> {
    const db = await getDatabase(dbInstance);
    const seasonId = await requireSeasonId(season, db);
    return db.execute<FplSeasonFixtureRow>(sql`
      SELECT
        fixture.fixture_id AS "fixtureId",
        fixture.code AS "fixtureCode",
        fixture.kickoff_time AS "kickoffAt",
        fixture.finished,
        home.code AS "homeTeamCode",
        away.code AS "awayTeamCode",
        fixture.team_h_score AS "homeGoals",
        fixture.team_a_score AS "awayGoals"
      FROM fpl.fixtures fixture
      JOIN fpl.teams home
        ON home.season_id = fixture.season_id AND home.team_id = fixture.team_h_id
      JOIN fpl.teams away
        ON away.season_id = fixture.season_id AND away.team_id = fixture.team_a_id
      WHERE fixture.season_id = ${seasonId}
    `);
  },

  async findPlayerEvidence(season: string): Promise<FplSeasonPlayerEvidenceRow[]> {
    const db = await getDatabase(dbInstance);
    const seasonId = await requireSeasonId(season, db);
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
      FROM fpl.player_fixture_stats evidence
      LEFT JOIN fpl.players player
        ON player.season_id = evidence.season_id AND player.code = evidence.player_code
      WHERE evidence.season_id = ${seasonId}
    `);
  },

  async findPlayers(season: string): Promise<FplSeasonPlayerRow[]> {
    const db = await getDatabase(dbInstance);
    const seasonId = await requireSeasonId(season, db);
    return db.execute<FplSeasonPlayerRow>(sql`
      SELECT
        code AS "playerCode",
        first_name AS "firstName",
        second_name AS "secondName",
        web_name AS "webName"
      FROM fpl.players
      WHERE season_id = ${seasonId}
    `);
  },
});

export const fplSeasonDataRepository = createFplSeasonDataRepository();
