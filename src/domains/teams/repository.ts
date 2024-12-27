import * as TE from 'fp-ts/TaskEither';
import { prisma } from '../../infrastructure/db/prisma';
import { APIError, createDatabaseError } from '../../infrastructure/http/common/errors';
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
   * Finds a team by its code
   * @param code - The team code to find
   * @returns TaskEither with found team or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findByCode: (code: number): TE.TaskEither<APIError, PrismaTeam | null> =>
    TE.tryCatch(
      () =>
        prisma.team.findFirst({
          where: { code },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find team by code', details: { error } }),
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
   * Saves multiple teams in a transaction
   * @param teams - Array of teams to save
   * @returns TaskEither with saved teams or error
   * @throws APIError with DB_ERROR code if save fails
   */
  saveBatch: (teams: PrismaTeamCreate[]): TE.TaskEither<APIError, PrismaTeam[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          teams.map((team) =>
            prisma.team.upsert({
              where: { id: Number(team.id) },
              update: team,
              create: {
                id: Number(team.id),
                ...team,
              },
            }),
          ),
        ),
      (error) => createDatabaseError({ message: 'Failed to save teams', details: { error } }),
    ),

  /**
   * Deletes all teams from the database
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.team.deleteMany();
        }),
      (error) => createDatabaseError({ message: 'Failed to delete teams', details: { error } }),
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
