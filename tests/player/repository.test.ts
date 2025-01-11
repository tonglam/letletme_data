import { ElementType, PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { DeepMockProxy, mockDeep } from 'jest-mock-extended';
import { createPlayerRepository } from '../../src/domain/player/repository';
import { DBErrorCode } from '../../src/types/error.type';
import { PlayerId, PrismaPlayer, PrismaPlayerCreate } from '../../src/types/player.type';

describe('Player Repository Tests', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  const testPlayer: PrismaPlayer = {
    element: 1,
    elementCode: 12345,
    price: 100,
    startPrice: 100,
    elementType: ElementType.GKP,
    firstName: 'Test',
    secondName: 'Player',
    webName: 'T.Player',
    teamId: 1,
    createdAt: new Date(),
  };

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
  });

  describe('findAll', () => {
    it('should return all players', async () => {
      prisma.player.findMany.mockResolvedValue([testPlayer]);
      const repository = createPlayerRepository(prisma);

      const result = await repository.findAll()();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual([testPlayer]);
      }
    });

    it('should handle database errors', async () => {
      prisma.player.findMany.mockRejectedValue(new Error('DB error'));
      const repository = createPlayerRepository(prisma);

      const result = await repository.findAll()();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DBErrorCode.QUERY_ERROR);
      }
    });
  });

  describe('findById', () => {
    it('should return player by id', async () => {
      prisma.player.findUnique.mockResolvedValue(testPlayer);
      const repository = createPlayerRepository(prisma);

      const result = await repository.findById(1 as PlayerId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual(testPlayer);
      }
    });

    it('should return null for non-existent player', async () => {
      prisma.player.findUnique.mockResolvedValue(null);
      const repository = createPlayerRepository(prisma);

      const result = await repository.findById(999 as PlayerId)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('saveBatch', () => {
    it('should create multiple players', async () => {
      const playersToCreate: PrismaPlayerCreate[] = [
        {
          element: testPlayer.element,
          elementCode: testPlayer.elementCode,
          price: testPlayer.price,
          startPrice: testPlayer.startPrice,
          elementType: testPlayer.elementType,
          firstName: testPlayer.firstName,
          secondName: testPlayer.secondName,
          webName: testPlayer.webName,
          teamId: testPlayer.teamId,
        },
      ];

      prisma.player.createMany.mockResolvedValue({ count: 1 });
      prisma.player.findMany.mockResolvedValue([testPlayer]);
      const repository = createPlayerRepository(prisma);

      const result = await repository.saveBatch(playersToCreate)();
      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        expect(result.right).toEqual([testPlayer]);
      }
    });
  });

  describe('updatePrices', () => {
    it('should update player prices in transaction', async () => {
      const updates = [{ id: 1 as PlayerId, price: 110 }];
      prisma.$transaction.mockResolvedValue([{ ...testPlayer, price: 110 }]);
      const repository = createPlayerRepository(prisma);

      const result = await repository.updatePrices(updates)();
      expect(E.isRight(result)).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('should handle transaction errors', async () => {
      const updates = [{ id: 1 as PlayerId, price: 110 }];
      prisma.$transaction.mockRejectedValue(new Error('Transaction error'));
      const repository = createPlayerRepository(prisma);

      const result = await repository.updatePrices(updates)();
      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(DBErrorCode.QUERY_ERROR);
      }
    });
  });
});
