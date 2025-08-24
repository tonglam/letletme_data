import { eq, sql } from 'drizzle-orm';

import { teams, type NewTeam, type Team } from '../db/schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Team as DomainTeam } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class TeamRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async findAll(): Promise<Team[]> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(teams).orderBy(teams.id);
      logInfo('Retrieved all teams', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to find all teams', error);
      throw new DatabaseError(
        'Failed to retrieve teams',
        'FIND_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async findById(id: number): Promise<Team | null> {
    try {
      const db = await this.getDbInstance();
      const result = await db.select().from(teams).where(eq(teams.id, id));
      const team = result[0] || null;

      if (team) {
        logInfo('Retrieved team by id', { id });
      } else {
        logInfo('Team not found', { id });
      }

      return team;
    } catch (error) {
      logError('Failed to find team by id', error, { id });
      throw new DatabaseError(
        `Failed to retrieve team with id: ${id}`,
        'FIND_BY_ID_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsert(team: DomainTeam): Promise<Team> {
    try {
      const newTeam: NewTeam = {
        id: team.id,
        name: team.name,
        shortName: team.shortName,
        code: team.code,
        draw: team.draw,
        form: team.form,
        loss: team.loss,
        played: team.played,
        points: team.points,
        position: team.position,
        strength: team.strength,
        teamDivision: team.teamDivision,
        unavailable: team.unavailable,
        win: team.win,
        strengthOverallHome: team.strengthOverallHome,
        strengthOverallAway: team.strengthOverallAway,
        strengthAttackHome: team.strengthAttackHome,
        strengthAttackAway: team.strengthAttackAway,
        strengthDefenceHome: team.strengthDefenceHome,
        strengthDefenceAway: team.strengthDefenceAway,
        pulseId: team.pulseId,
        updatedAt: new Date(),
      };

      const db = await this.getDbInstance();
      const result = await db
        .insert(teams)
        .values(newTeam)
        .onConflictDoUpdate({
          target: teams.id,
          set: {
            ...newTeam,
            updatedAt: new Date(),
          },
        })
        .returning();

      const upsertedTeam = result[0];
      logInfo('Upserted team', { id: upsertedTeam.id });
      return upsertedTeam;
    } catch (error) {
      logError('Failed to upsert team', error, { id: team.id });
      throw new DatabaseError(
        `Failed to upsert team with id: ${team.id}`,
        'UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async upsertBatch(domainTeams: DomainTeam[]): Promise<Team[]> {
    try {
      if (domainTeams.length === 0) {
        return [];
      }

      const newTeams: NewTeam[] = domainTeams.map((team) => ({
        id: team.id,
        name: team.name,
        shortName: team.shortName,
        code: team.code,
        draw: team.draw,
        form: team.form,
        loss: team.loss,
        played: team.played,
        points: team.points,
        position: team.position,
        strength: team.strength,
        teamDivision: team.teamDivision,
        unavailable: team.unavailable,
        win: team.win,
        strengthOverallHome: team.strengthOverallHome,
        strengthOverallAway: team.strengthOverallAway,
        strengthAttackHome: team.strengthAttackHome,
        strengthAttackAway: team.strengthAttackAway,
        strengthDefenceHome: team.strengthDefenceHome,
        strengthDefenceAway: team.strengthDefenceAway,
        pulseId: team.pulseId,
        updatedAt: new Date(),
      }));

      const db = await this.getDbInstance();
      const result = await db
        .insert(teams)
        .values(newTeams)
        .onConflictDoUpdate({
          target: teams.id,
          set: {
            name: sql`excluded.name`,
            shortName: sql`excluded.short_name`,
            code: sql`excluded.code`,
            draw: sql`excluded.draw`,
            form: sql`excluded.form`,
            loss: sql`excluded.loss`,
            played: sql`excluded.played`,
            points: sql`excluded.points`,
            position: sql`excluded.position`,
            strength: sql`excluded.strength`,
            teamDivision: sql`excluded.team_division`,
            unavailable: sql`excluded.unavailable`,
            win: sql`excluded.win`,
            strengthOverallHome: sql`excluded.strength_overall_home`,
            strengthOverallAway: sql`excluded.strength_overall_away`,
            strengthAttackHome: sql`excluded.strength_attack_home`,
            strengthAttackAway: sql`excluded.strength_attack_away`,
            strengthDefenceHome: sql`excluded.strength_defence_home`,
            strengthDefenceAway: sql`excluded.strength_defence_away`,
            pulseId: sql`excluded.pulse_id`,
            updatedAt: new Date(),
          },
        })
        .returning();

      logInfo('Batch upserted teams', { count: result.length });
      return result;
    } catch (error) {
      logError('Failed to batch upsert teams', error, { count: domainTeams.length });
      throw new DatabaseError(
        'Failed to batch upsert teams',
        'BATCH_UPSERT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deleteAll(): Promise<void> {
    try {
      const db = await this.getDbInstance();
      await db.delete(teams);
      logInfo('Deleted all teams');
    } catch (error) {
      logError('Failed to delete all teams', error);
      throw new DatabaseError(
        'Failed to delete all teams',
        'DELETE_ALL_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  }
}

// Export singleton instance
export const teamRepository = new TeamRepository();
