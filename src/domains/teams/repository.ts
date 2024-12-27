import { Prisma } from '@prisma/client';
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
      async () => {
        return prisma.team.create({ data: team });
      },
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to save team', details: { error } }),
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
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to find team', details: { error } }),
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
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to find teams', details: { error } }),
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
      async () => {
        const data: Prisma.TeamUpdateInput = {
          code: team.code !== undefined ? team.code : undefined,
          name: team.name !== undefined ? team.name : undefined,
          shortName: team.shortName !== undefined ? team.shortName : undefined,
          strength: team.strength !== undefined ? team.strength : undefined,
          strengthOverallHome:
            team.strengthOverallHome !== undefined ? team.strengthOverallHome : undefined,
          strengthOverallAway:
            team.strengthOverallAway !== undefined ? team.strengthOverallAway : undefined,
          strengthAttackHome:
            team.strengthAttackHome !== undefined ? team.strengthAttackHome : undefined,
          strengthAttackAway:
            team.strengthAttackAway !== undefined ? team.strengthAttackAway : undefined,
          strengthDefenceHome:
            team.strengthDefenceHome !== undefined ? team.strengthDefenceHome : undefined,
          strengthDefenceAway:
            team.strengthDefenceAway !== undefined ? team.strengthDefenceAway : undefined,
          pulseId: team.pulseId !== undefined ? team.pulseId : undefined,
          played: team.played !== undefined ? team.played : undefined,
          position: team.position !== undefined ? team.position : undefined,
          points: team.points !== undefined ? team.points : undefined,
          form: team.form !== undefined ? team.form : undefined,
          win: team.win !== undefined ? team.win : undefined,
          draw: team.draw !== undefined ? team.draw : undefined,
          loss: team.loss !== undefined ? team.loss : undefined,
          teamDivision: team.teamDivision !== undefined ? team.teamDivision : undefined,
          unavailable: team.unavailable !== undefined ? team.unavailable : undefined,
        };
        return prisma.team.update({
          where: { id: Number(id) },
          data,
        });
      },
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to update team', details: { error } }),
    ),

  /**
   * Creates a batch of new teams
   * @param teams - The teams data to create
   * @returns TaskEither with created teams or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  saveBatch: (teams: PrismaTeamCreate[]): TE.TaskEither<APIError, PrismaTeam[]> =>
    TE.tryCatch(
      async () => {
        const createTeams = teams.map((team) => prisma.team.create({ data: team }));
        return prisma.$transaction(createTeams);
      },
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to save teams', details: { error } }),
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
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to find teams', details: { error } }),
    ),

  /**
   * Deletes all teams
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      async () => {
        await prisma.team.deleteMany();
      },
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to delete teams', details: { error } }),
    ),

  /**
   * Deletes teams by their IDs
   * @param ids - The team IDs to delete
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: TeamId[]): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      async () => {
        await prisma.team.deleteMany({
          where: { id: { in: ids.map(Number) } },
        });
      },
      (error: unknown) =>
        createDatabaseError({ message: 'Failed to delete teams', details: { error } }),
    ),
};
