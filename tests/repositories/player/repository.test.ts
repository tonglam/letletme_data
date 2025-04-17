import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { beforeEach, describe, expect, it } from 'vitest';

import { createPlayerRepository } from '../../../src/repositories/player/repository';
import { PrismaPlayerCreate } from '../../../src/repositories/player/type';
import { ElementType } from '../../../src/types/base.type';
import { Player, PlayerId } from '../../../src/types/domain/player.type';
import { DBErrorCode } from '../../../src/types/error.type';
import { createMockPrismaClient, resetMockPrismaClient } from '../../utils/prisma-mock';

describe('Player Repository', () => {
  // Using the mock Prisma client utility
  const mockPrisma = createMockPrismaClient();

  // Mock player data
  const mockPrismaPlayer = {
    element: 1,
    elementCode: 1,
    price: 50, // stored as price * 10
    startPrice: 50,
    elementType: ElementType.FORWARD,
    firstName: 'John',
    secondName: 'Doe',
    webName: 'Doe',
    teamId: 1,
    createdAt: new Date(),
  };

  const expectedDomainPlayer: Player = {
    id: 1 as PlayerId,
    elementCode: 1,
    price: 5, // converted from price/10
    startPrice: 5,
    elementType: ElementType.FORWARD,
    firstName: 'John',
    secondName: 'Doe',
    webName: 'Doe',
    teamId: 1,
  };

  // Create repository instance
  const repository = createPlayerRepository(mockPrisma as any);

  beforeEach(() => {
    resetMockPrismaClient();
  });

  describe('findAll', () => {
    it('should return all players', async () => {
      // Arrange
      mockPrisma.player.findMany.mockResolvedValue([mockPrismaPlayer]);

      // Act
      const result = await pipe(
        repository.findAll(),
        TE.getOrElse((error) => {
          throw new Error(`Test failed with error: ${error.message}`);
        }),
      )();

      // Assert
      expect(mockPrisma.player.findMany).toHaveBeenCalledWith({
        orderBy: { element: 'asc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expectedDomainPlayer);
    });

    it('should return DB error when query fails', async () => {
      // Arrange
      const errorMessage = 'Database connection error';
      mockPrisma.player.findMany.mockRejectedValue(new Error(errorMessage));

      // Act
      const result = await repository.findAll()();

      // Assert
      expect(result).toEqual({
        _tag: 'Left',
        left: expect.objectContaining({
          code: DBErrorCode.QUERY_ERROR,
          message: expect.stringContaining('Failed to fetch all players'),
        }),
      });
    });
  });

  describe('findById', () => {
    it('should return a player when found', async () => {
      // Arrange
      const playerId = 1 as PlayerId;
      mockPrisma.player.findUnique.mockResolvedValue(mockPrismaPlayer);

      // Act
      const result = await pipe(
        repository.findById(playerId),
        TE.getOrElse((error) => {
          throw new Error(`Test failed with error: ${error.message}`);
        }),
      )();

      // Assert
      expect(mockPrisma.player.findUnique).toHaveBeenCalledWith({
        where: { element: 1 },
      });
      expect(result).toEqual(expectedDomainPlayer);
    });

    it('should return null when player not found', async () => {
      // Arrange
      const playerId = 999 as PlayerId;
      mockPrisma.player.findUnique.mockResolvedValue(null);

      // Act
      const result = await pipe(
        repository.findById(playerId),
        TE.getOrElse((error) => {
          throw new Error(`Test failed with error: ${error.message}`);
        }),
      )();

      // Assert
      expect(mockPrisma.player.findUnique).toHaveBeenCalledWith({
        where: { element: 999 },
      });
      expect(result).toBeNull();
    });

    it('should return DB error when query fails', async () => {
      // Arrange
      const playerId = 1 as PlayerId;
      mockPrisma.player.findUnique.mockRejectedValue(new Error('Database error'));

      // Act
      const result = await repository.findById(playerId)();

      // Assert
      expect(result).toEqual({
        _tag: 'Left',
        left: expect.objectContaining({
          code: DBErrorCode.QUERY_ERROR,
          message: expect.stringContaining(`Failed to fetch player by id ${playerId}`),
        }),
      });
    });
  });

  describe('saveBatch', () => {
    it('should save multiple players and return them', async () => {
      // Arrange
      const playersToCreate: readonly PrismaPlayerCreate[] = [
        {
          element: 1,
          elementCode: 1,
          price: 5, // Changed from 50 to 5 to match mapper expectation
          startPrice: 5, // Changed from 50 to 5 to match mapper expectation
          elementType: ElementType.FORWARD,
          firstName: 'John',
          secondName: 'Doe',
          webName: 'Doe',
          teamId: 1,
          id: 1 as PlayerId,
          createdAt: new Date(),
        },
      ];

      mockPrisma.player.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.player.findMany.mockResolvedValue([mockPrismaPlayer]);

      // Act
      const result = await pipe(
        repository.saveBatch(playersToCreate),
        TE.getOrElse((error) => {
          throw new Error(`Test failed with error: ${error.message}`);
        }),
      )();

      // Assert
      expect(mockPrisma.player.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            element: 1,
            price: 50, // Mapper multiplies price by 10 (5 * 10 = 50)
          }),
        ]),
        skipDuplicates: true,
      });

      expect(mockPrisma.player.findMany).toHaveBeenCalledWith({
        where: { element: { in: [1] } },
        orderBy: { element: 'asc' },
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(expectedDomainPlayer);
    });

    it('should return DB error when query fails', async () => {
      // Arrange
      const playersToCreate: readonly PrismaPlayerCreate[] = [
        {
          element: 1,
          elementCode: 1,
          price: 5, // Changed from 50 to 5 to match mapper expectation
          startPrice: 5, // Changed from 50 to 5 to match mapper expectation
          elementType: ElementType.FORWARD,
          firstName: 'John',
          secondName: 'Doe',
          webName: 'Doe',
          teamId: 1,
          id: 1 as PlayerId,
          createdAt: new Date(),
        },
      ];

      mockPrisma.player.createMany.mockRejectedValue(new Error('Database error'));

      // Act
      const result = await repository.saveBatch(playersToCreate)();

      // Assert
      expect(result).toEqual({
        _tag: 'Left',
        left: expect.objectContaining({
          code: DBErrorCode.QUERY_ERROR,
          message: expect.stringContaining('Failed to create players in batch'),
        }),
      });
    });
  });

  describe('deleteAll', () => {
    it('should delete all players', async () => {
      // Arrange
      mockPrisma.player.deleteMany.mockResolvedValue({ count: 10 });

      // Act
      const result = await pipe(
        repository.deleteAll(),
        TE.getOrElse((error) => {
          throw new Error(`Test failed with error: ${error.message}`);
        }),
      )();

      // Assert
      expect(mockPrisma.player.deleteMany).toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('should return DB error when query fails', async () => {
      // Arrange
      mockPrisma.player.deleteMany.mockRejectedValue(new Error('Database error'));

      // Act
      const result = await repository.deleteAll()();

      // Assert
      expect(result).toEqual({
        _tag: 'Left',
        left: expect.objectContaining({
          code: DBErrorCode.QUERY_ERROR,
          message: expect.stringContaining('Failed to delete all players'),
        }),
      });
    });
  });
});
