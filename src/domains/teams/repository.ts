import * as TE from 'fp-ts/TaskEither';
import { APIError, createDatabaseError } from '../../infrastructure/api/common/errors';
import { prisma } from '../../infrastructure/db/prisma';
import { PrismaTeam, PrismaTeamCreate, TeamId, TeamRepository } from '../../types/teams.type';

/**
 * Team repository implementation
 * Provides data access operations for Team entity
 */
export const teamRepository: TeamRepository = {
  prisma,
  /**
   * Creates a new team
   * @param team - The team data to create
   * @returns TaskEither with created team or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  save: (team: PrismaTeamCreate): TE.TaskEither<APIError, PrismaTeam> =>
    TE.tryCatch(
      () =>
        prisma.team.upsert({
          where: { id: Number(team.id) },
          update: {
            code: team.code,
            name: team.name,
            shortName: team.shortName,
            strength: team.strength,
            strengthOverallHome: team.strengthOverallHome,
            strengthOverallAway: team.strengthOverallAway,
            strengthAttackHome: team.strengthAttackHome,
            strengthAttackAway: team.strengthAttackAway,
            strengthDefenceHome: team.strengthDefenceHome,
            strengthDefenceAway: team.strengthDefenceAway,
            pulseId: team.pulseId,
            played: team.played,
            position: team.position,
            points: team.points,
            form: team.form,
            win: team.win,
            draw: team.draw,
            loss: team.loss,
            teamDivision: team.teamDivision,
            unavailable: team.unavailable,
            createdAt: team.createdAt ?? new Date(),
          },
          create: {
            id: Number(team.id),
            code: team.code,
            name: team.name,
            shortName: team.shortName,
            strength: team.strength,
            strengthOverallHome: team.strengthOverallHome,
            strengthOverallAway: team.strengthOverallAway,
            strengthAttackHome: team.strengthAttackHome,
            strengthAttackAway: team.strengthAttackAway,
            strengthDefenceHome: team.strengthDefenceHome,
            strengthDefenceAway: team.strengthDefenceAway,
            pulseId: team.pulseId,
            played: team.played,
            position: team.position,
            points: team.points,
            form: team.form,
            win: team.win,
            draw: team.draw,
            loss: team.loss,
            teamDivision: team.teamDivision,
            unavailable: team.unavailable,
            createdAt: team.createdAt ?? new Date(),
          },
        }),
      (error) => createDatabaseError({ message: 'Failed to save team', details: { error } }),
    ),

  /**
   * Finds a team by its ID
   * @param id - The team ID to find
   * @returns TaskEither with found team or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findById: (id: TeamId): TE.TaskEither<APIError, PrismaTeam | null> =>
    TE.tryCatch(
      () =>
        prisma.team.findUnique({
          where: { id: Number(id) },
        }),
      (error) => createDatabaseError({ message: 'Failed to find team', details: { error } }),
    ),

  /**
   * Retrieves all teams ordered by position
   * @returns TaskEither with array of teams or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findAll: (): TE.TaskEither<APIError, PrismaTeam[]> =>
    TE.tryCatch(
      () =>
        prisma.team.findMany({
          orderBy: { position: 'asc' },
        }),
      (error) => createDatabaseError({ message: 'Failed to find teams', details: { error } }),
    ),

  /**
   * Updates an existing team
   * @param id - The ID of the team to update
   * @param team - The partial team data to update
   * @returns TaskEither with updated team or error
   * @throws APIError with DB_ERROR code if update fails
   */
  update: (id: TeamId, team: Partial<PrismaTeamCreate>): TE.TaskEither<APIError, PrismaTeam> =>
    TE.tryCatch(
      () =>
        prisma.team.update({
          where: { id: Number(id) },
          data: team,
        }),
      (error) => createDatabaseError({ message: 'Failed to update team', details: { error } }),
    ),

  /**
   * Deletes all teams
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.team.deleteMany({});
        }),
      (error) => createDatabaseError({ message: 'Failed to delete teams', details: { error } }),
    ),

  /**
   * Creates a batch of new teams
   * @param teams - The teams data to create
   * @returns TaskEither with created teams or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  saveBatch: (teams: PrismaTeamCreate[]): TE.TaskEither<APIError, PrismaTeam[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          teams.map((team) =>
            prisma.team.upsert({
              where: { id: Number(team.id) },
              update: {
                code: team.code,
                name: team.name,
                shortName: team.shortName,
                strength: team.strength,
                strengthOverallHome: team.strengthOverallHome,
                strengthOverallAway: team.strengthOverallAway,
                strengthAttackHome: team.strengthAttackHome,
                strengthAttackAway: team.strengthAttackAway,
                strengthDefenceHome: team.strengthDefenceHome,
                strengthDefenceAway: team.strengthDefenceAway,
                pulseId: team.pulseId,
                played: team.played,
                position: team.position,
                points: team.points,
                form: team.form,
                win: team.win,
                draw: team.draw,
                loss: team.loss,
                teamDivision: team.teamDivision,
                unavailable: team.unavailable,
                createdAt: team.createdAt ?? new Date(),
              },
              create: {
                id: Number(team.id),
                code: team.code,
                name: team.name,
                shortName: team.shortName,
                strength: team.strength,
                strengthOverallHome: team.strengthOverallHome,
                strengthOverallAway: team.strengthOverallAway,
                strengthAttackHome: team.strengthAttackHome,
                strengthAttackAway: team.strengthAttackAway,
                strengthDefenceHome: team.strengthDefenceHome,
                strengthDefenceAway: team.strengthDefenceAway,
                pulseId: team.pulseId,
                played: team.played,
                position: team.position,
                points: team.points,
                form: team.form,
                win: team.win,
                draw: team.draw,
                loss: team.loss,
                teamDivision: team.teamDivision,
                unavailable: team.unavailable,
                createdAt: team.createdAt ?? new Date(),
              },
            }),
          ),
        ),
      (error) => createDatabaseError({ message: 'Failed to save teams', details: { error } }),
    ),

  /**
   * Finds teams by their IDs
   * @param ids - The team IDs to find
   * @returns TaskEither with found teams or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByIds: (ids: TeamId[]): TE.TaskEither<APIError, PrismaTeam[]> =>
    TE.tryCatch(
      () =>
        prisma.team.findMany({
          where: { id: { in: ids.map(Number) } },
        }),
      (error) => createDatabaseError({ message: 'Failed to find teams', details: { error } }),
    ),

  /**
   * Deletes teams by their IDs
   * @param ids - The team IDs to delete
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: TeamId[]): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.team.deleteMany({
            where: { id: { in: ids.map(Number) } },
          });
        }),
      (error) => createDatabaseError({ message: 'Failed to delete teams', details: { error } }),
    ),
};
