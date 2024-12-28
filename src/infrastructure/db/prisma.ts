/**
 * Prisma Client Module
 *
 * Provides a singleton Prisma client instance for database operations.
 * Handles connection management and error handling.
 *
 * Features:
 * - Singleton pattern implementation
 * - Global instance management
 * - Connection lifecycle handling
 * - Error logging configuration
 * - Functional error handling with fp-ts
 *
 * The module ensures a single database connection is maintained
 * throughout the application lifecycle, with proper error handling
 * and connection management.
 */

import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';

/**
 * Global Prisma client instance.
 * Ensures single instance across Node.js module system.
 */
const globalForPrisma = global as { prisma?: PrismaClient };

/**
 * Singleton Prisma client instance.
 * Created with configured logging options and reused across the application.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

/**
 * Development environment handling.
 * Preserves Prisma client instance across hot reloads.
 */
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Establishes connection to the database.
 * Handles connection lifecycle and error states.
 *
 * @returns Either indicating connection success or failure
 * @throws Error with detailed message if connection fails
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
 * Gracefully disconnects from the database.
 * Ensures proper cleanup of resources.
 *
 * @returns Either indicating disconnection success or failure
 * @throws Error with detailed message if disconnection fails
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
