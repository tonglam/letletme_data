import { eq, sql } from 'drizzle-orm';

import { teamsInFpl, type DbTeam, type DbTeamInsert } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Team as DomainTeam } from '../types';

function mapDbTeamToDomain(team: DbTeam): DomainTeam {
  return {
    id: team.teamId,
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
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export const createTeamRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findAll: async (season: FplSeasonRef): Promise<DomainTeam[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(teamsInFpl)
          .where(eq(teamsInFpl.seasonId, season.seasonId));
        return rows.map(mapDbTeamToDomain);
      } catch (error) {
        logError('Failed to retrieve teamsInFpl', error, { season: season.seasonCode });
        throw new DatabaseError(
          'Failed to retrieve teamsInFpl',
          'FIND_ALL_TEAMS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertBatch: async (season: FplSeasonRef, domainTeams: DomainTeam[]): Promise<DbTeam[]> => {
      try {
        if (domainTeams.length === 0) {
          return [];
        }

        const newTeams: DbTeamInsert[] = domainTeams.map((team) => ({
          seasonId: season.seasonId,
          teamId: team.id,
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
          .insert(teamsInFpl)
          .values(newTeams)
          .onConflictDoUpdate({
            target: [teamsInFpl.seasonId, teamsInFpl.teamId],
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

        logInfo('Batch upserted teamsInFpl', { count: result.length, season: season.seasonCode });
        return result;
      } catch (error) {
        logError('Failed to batch upsert teamsInFpl', error, {
          count: domainTeams.length,
          season: season.seasonCode,
        });
        throw new DatabaseError(
          'Failed to batch upsert teamsInFpl',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

// Export singleton instance
export const teamRepository = createTeamRepository();
