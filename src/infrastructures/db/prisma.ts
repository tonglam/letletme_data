import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { DBError, DBErrorCode, createDBError } from '../../types/error.type';

const globalForPrisma = global as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

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
