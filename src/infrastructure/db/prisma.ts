/**
 * Prisma Client Module
 *
 * Provides a singleton Prisma client instance for database operations.
 * Implements functional programming patterns with fp-ts for type-safe error handling.
 */

import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError, DBErrorCode, createDBError } from '../../types/errors.type';

/**
 * Global Prisma client instance
 * Ensures single client instance across the application
 */
const globalForPrisma = global as { prisma?: PrismaClient };

/**
 * Singleton Prisma client instance
 * Creates a new Prisma client with configured options if none exists
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

/**
 * Development environment handling
 * Preserves client instance during development hot reloads
 */
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Establishes database connection
 * Connects to database if not already connected
 *
 * @returns TaskEither resolving to void on success, or DBError on failure
 */
export const connectDB = (): TE.TaskEither<DBError, void> =>
  TE.tryCatch(
    async () => {
      await prisma.$connect();
    },
    (error) =>
      createDBError({
        code: DBErrorCode.CONNECTION_ERROR,
        message: `Failed to connect to database: ${error instanceof Error ? error.message : 'Unknown error'}`,
        cause: error instanceof Error ? error : undefined,
      }),
  );

/**
 * Disconnects from database
 * Gracefully closes database connection if open
 *
 * @returns TaskEither resolving to void on success, or DBError on failure
 */
export const disconnectDB = (): TE.TaskEither<DBError, void> =>
  TE.tryCatch(
    async () => {
      await prisma.$disconnect();
    },
    (error) =>
      createDBError({
        code: DBErrorCode.CONNECTION_ERROR,
        message: `Failed to disconnect from database: ${error instanceof Error ? error.message : 'Unknown error'}`,
        cause: error instanceof Error ? error : undefined,
      }),
  );
