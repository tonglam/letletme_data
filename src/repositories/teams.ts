import { sql } from 'drizzle-orm';

import { teams, type DbTeam, type DbTeamInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Team as DomainTeam } from '../types';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createTeamRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertBatch: async (domainTeams: DomainTeam[]): Promise<DbTeam[]> => {
      try {
        if (domainTeams.length === 0) {
          return [];
        }

        const newTeams: DbTeamInsert[] = domainTeams.map((team) => ({
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
        }));

        const db = await getDbInstance();
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
              updatedAt: sql`NOW()`,
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
    },
  };
};

// Export singleton instance
export const teamRepository = createTeamRepository();
