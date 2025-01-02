// Prisma client module providing a singleton instance for database operations.
// Implements functional programming patterns with fp-ts for type-safe error handling.

import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError, DBErrorCode, createDBError } from '../../types/errors.type';

// Global Prisma client instance
const globalForPrisma = global as { prisma?: PrismaClient };

// Singleton Prisma client instance with configured options
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

// Preserve client instance during development hot reloads
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Establishes database connection if not already connected
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

// Disconnects from database
// Gracefully closes database connection if open
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
