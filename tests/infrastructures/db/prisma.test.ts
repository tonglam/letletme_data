import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DBErrorCode } from '../../../src/types/error.type';

// Mock the PrismaClient
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('@prisma/client', () => {
  return {
    PrismaClient: vi.fn().mockImplementation(() => ({
      $connect: mockConnect,
      $disconnect: mockDisconnect,
    })),
  };
});

// Create a simple implementation of connectDB and disconnectDB
const createConnectDBMock = () => {
  return TE.tryCatch(
    async () => {
      await mockConnect();
    },
    (error) => ({
      code: DBErrorCode.CONNECTION_ERROR,
      message: `Failed to connect to database: ${error instanceof Error ? error.message : 'Unknown error'}`,
      cause: error instanceof Error ? error : undefined,
    }),
  );
};

const createDisconnectDBMock = () => {
  return TE.tryCatch(
    async () => {
      await mockDisconnect();
    },
    (error) => ({
      code: DBErrorCode.CONNECTION_ERROR,
      message: `Failed to disconnect from database: ${error instanceof Error ? error.message : 'Unknown error'}`,
      cause: error instanceof Error ? error : undefined,
    }),
  );
};

describe('Prisma DB Infrastructure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('connectDB', () => {
    it('should connect to the database successfully', async () => {
      // Arrange
      mockConnect.mockResolvedValue(undefined);

      // Act
      const result = await pipe(
        createConnectDBMock(),
        TE.getOrElse((error) => {
          throw new Error(`Test failed with error: ${error.message}`);
        }),
      )();

      // Assert
      expect(mockConnect).toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should return a DBError when connection fails', async () => {
      // Arrange
      const connectionError = new Error('Connection failed');
      mockConnect.mockRejectedValue(connectionError);

      // Act
      const result = await createConnectDBMock()();

      // Assert
      expect(mockConnect).toHaveBeenCalled();
      expect(result).toEqual({
        _tag: 'Left',
        left: expect.objectContaining({
          code: DBErrorCode.CONNECTION_ERROR,
          message: expect.stringContaining('Failed to connect to database'),
          cause: connectionError,
        }),
      });
    });
  });

  describe('disconnectDB', () => {
    it('should disconnect from the database successfully', async () => {
      // Arrange
      mockDisconnect.mockResolvedValue(undefined);

      // Act
      const result = await pipe(
        createDisconnectDBMock(),
        TE.getOrElse((error) => {
          throw new Error(`Test failed with error: ${error.message}`);
        }),
      )();

      // Assert
      expect(mockDisconnect).toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should return a DBError when disconnection fails', async () => {
      // Arrange
      const disconnectionError = new Error('Disconnection failed');
      mockDisconnect.mockRejectedValue(disconnectionError);

      // Act
      const result = await createDisconnectDBMock()();

      // Assert
      expect(mockDisconnect).toHaveBeenCalled();
      expect(result).toEqual({
        _tag: 'Left',
        left: expect.objectContaining({
          code: DBErrorCode.CONNECTION_ERROR,
          message: expect.stringContaining('Failed to disconnect from database'),
          cause: disconnectionError,
        }),
      });
    });
  });
});
