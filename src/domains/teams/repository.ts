import { Prisma } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { prisma } from '../../infrastructure/db/prisma';
import { APIError, createDatabaseError } from '../../infrastructure/http/common/errors';
import { PrismaTeam, PrismaTeamCreate, TeamId, TeamRepository } from '../../types/teams.type';
import { getDefinedValue } from '../../utils/domain';

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
          code: getDefinedValue(team.code),
          name: getDefinedValue(team.name),
          shortName: getDefinedValue(team.shortName),
          strength: getDefinedValue(team.strength),
          strengthOverallHome: getDefinedValue(team.strengthOverallHome),
          strengthOverallAway: getDefinedValue(team.strengthOverallAway),
          strengthAttackHome: getDefinedValue(team.strengthAttackHome),
          strengthAttackAway: getDefinedValue(team.strengthAttackAway),
          strengthDefenceHome: getDefinedValue(team.strengthDefenceHome),
          strengthDefenceAway: getDefinedValue(team.strengthDefenceAway),
          pulseId: getDefinedValue(team.pulseId),
          played: getDefinedValue(team.played),
          position: getDefinedValue(team.position),
          points: getDefinedValue(team.points),
          form: getDefinedValue(team.form),
          win: getDefinedValue(team.win),
          draw: getDefinedValue(team.draw),
          loss: getDefinedValue(team.loss),
          teamDivision: getDefinedValue(team.teamDivision),
          unavailable: getDefinedValue(team.unavailable),
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
