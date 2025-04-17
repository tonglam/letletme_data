import * as TE from 'fp-ts/TaskEither';
import { vi } from 'vitest';

// Mock functions
export const mockConnect = vi.fn();
export const mockDisconnect = vi.fn();

// Mock connect function
export const connectDB = vi.fn(() =>
  TE.tryCatch(
    async () => {
      return await mockConnect();
    },
    (error) => ({
      code: 'CONNECTION_ERROR',
      message: `Failed to connect to database: ${error instanceof Error ? error.message : 'Unknown error'}`,
      cause: error instanceof Error ? error : undefined,
    }),
  ),
);

// Mock disconnect function
export const disconnectDB = vi.fn(() =>
  TE.tryCatch(
    async () => {
      return await mockDisconnect();
    },
    (error) => ({
      code: 'CONNECTION_ERROR',
      message: `Failed to disconnect from database: ${error instanceof Error ? error.message : 'Unknown error'}`,
      cause: error instanceof Error ? error : undefined,
    }),
  ),
);

// Mock prisma client
export const prisma = {
  $connect: mockConnect,
  $disconnect: mockDisconnect,
};
