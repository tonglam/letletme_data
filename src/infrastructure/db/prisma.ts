import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';

// Create a singleton instance of PrismaClient
const globalForPrisma = global as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

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
