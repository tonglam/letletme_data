/**
 * Prisma Client Module
 *
 * Singleton Prisma client instance for database operations.
 */

import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';

/**
 * Global Prisma client instance
 */
const globalForPrisma = global as { prisma?: PrismaClient };

/**
 * Singleton Prisma client instance
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

/**
 * Development environment handling
 */
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Establishes database connection
 */
export const connectDB = async (): Promise<E.Either<Error, void>> => {
  try {
    await prisma.$connect();
    return E.right(undefined);
  } catch (error) {
    return E.left(
      new Error(
        `Failed to connect to database: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ),
    );
  }
};

/**
 * Disconnects from database
 */
export const disconnectDB = async (): Promise<E.Either<Error, void>> => {
  try {
    await prisma.$disconnect();
    return E.right(undefined);
  } catch (error) {
    return E.left(
      new Error(
        `Failed to disconnect from database: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ),
    );
  }
};
