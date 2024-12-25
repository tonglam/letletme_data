import * as TE from 'fp-ts/TaskEither';
import { APIError, createDatabaseError } from '../../infrastructure/api/common/errors';
import { prisma } from '../../infrastructure/db/prisma';
import { PhaseId, PhaseRepository, PrismaPhase, PrismaPhaseCreate } from '../../types/phase.type';

/**
 * Phase repository implementation
 * Provides data access operations for Phase entity
 */
export const phaseRepository: PhaseRepository = {
  prisma,
  /**
   * Creates a new phase
   * @param phase - The phase data to create
   * @returns TaskEither with created phase or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  save: (phase: PrismaPhaseCreate): TE.TaskEither<APIError, PrismaPhase> =>
    TE.tryCatch(
      () =>
        prisma.phase.upsert({
          where: { id: Number(phase.id) },
          update: {
            name: phase.name,
            startEvent: phase.startEvent,
            stopEvent: phase.stopEvent,
            highestScore: phase.highestScore,
            createdAt: phase.createdAt ?? new Date(),
          },
          create: {
            id: Number(phase.id),
            name: phase.name,
            startEvent: phase.startEvent,
            stopEvent: phase.stopEvent,
            highestScore: phase.highestScore,
            createdAt: phase.createdAt ?? new Date(),
          },
        }),
      (error) => createDatabaseError({ message: 'Failed to save phase', details: { error } }),
    ),

  /**
   * Finds a phase by its ID
   * @param id - The phase ID to find
   * @returns TaskEither with found phase or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findById: (id: PhaseId): TE.TaskEither<APIError, PrismaPhase | null> =>
    TE.tryCatch(
      () =>
        prisma.phase.findUnique({
          where: { id: Number(id) },
        }),
      (error) => createDatabaseError({ message: 'Failed to find phase', details: { error } }),
    ),

  /**
   * Retrieves all phases ordered by startEventId
   * @returns TaskEither with array of phases or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findAll: (): TE.TaskEither<APIError, PrismaPhase[]> =>
    TE.tryCatch(
      () =>
        prisma.phase.findMany({
          orderBy: { startEvent: 'asc' },
        }),
      (error) => createDatabaseError({ message: 'Failed to find phases', details: { error } }),
    ),

  /**
   * Updates an existing phase
   * @param id - The ID of the phase to update
   * @param phase - The partial phase data to update
   * @returns TaskEither with updated phase or error
   * @throws APIError with DB_ERROR code if update fails
   */
  update: (id: PhaseId, phase: Partial<PrismaPhaseCreate>): TE.TaskEither<APIError, PrismaPhase> =>
    TE.tryCatch(
      () =>
        prisma.phase.update({
          where: { id: Number(id) },
          data: phase,
        }),
      (error) => createDatabaseError({ message: 'Failed to update phase', details: { error } }),
    ),

  /**
   * Deletes all phases except system defaults
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.phase.deleteMany({
            where: { id: { gt: 0 } }, // Preserve system defaults if any
          });
        }),
      (error) => createDatabaseError({ message: 'Failed to delete phases', details: { error } }),
    ),

  /**
   * Creates a batch of new phases
   * @param phases - The phases data to create
   * @returns TaskEither with created phases or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  saveBatch: (phases: PrismaPhaseCreate[]): TE.TaskEither<APIError, PrismaPhase[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          phases.map((phase) =>
            prisma.phase.upsert({
              where: { id: Number(phase.id) },
              update: {
                name: phase.name,
                startEvent: phase.startEvent,
                stopEvent: phase.stopEvent,
                highestScore: phase.highestScore,
                createdAt: phase.createdAt ?? new Date(),
              },
              create: {
                id: Number(phase.id),
                name: phase.name,
                startEvent: phase.startEvent,
                stopEvent: phase.stopEvent,
                highestScore: phase.highestScore,
                createdAt: phase.createdAt ?? new Date(),
              },
            }),
          ),
        ),
      (error) => createDatabaseError({ message: 'Failed to save phases', details: { error } }),
    ),

  /**
   * Finds phases by their IDs
   * @param ids - The phase IDs to find
   * @returns TaskEither with found phases or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByIds: (ids: PhaseId[]): TE.TaskEither<APIError, PrismaPhase[]> =>
    TE.tryCatch(
      () =>
        prisma.phase.findMany({
          where: { id: { in: ids.map(Number) } },
        }),
      (error) => createDatabaseError({ message: 'Failed to find phases', details: { error } }),
    ),

  /**
   * Deletes phases by their IDs
   * @param ids - The phase IDs to delete
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: PhaseId[]): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.phase.deleteMany({
            where: { id: { in: ids.map(Number) } },
          });
        }),
      (error) => createDatabaseError({ message: 'Failed to delete phases', details: { error } }),
    ),
};
