import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { createPlayerStatRepository } from '../../src/domain/player-stat/repository';
import { toDomainPlayerStat, toPrismaPlayerStat } from '../../src/domain/player-stat/types';
import { prisma } from '../../src/infrastructure/db/prisma';
import type { ElementResponse } from '../../src/types/element.type';
import type {
  PlayerStat,
  PrismaPlayerStat,
  PrismaPlayerStatCreate,
} from '../../src/types/player-stat.type';
import { validatePlayerStatId } from '../../src/types/player-stat.type';
import bootstrapData from '../data/bootstrap.json';

describe('Player Stat Repository Tests', () => {
  let testPlayerStats: PlayerStat[];
  let testPrismaPlayerStats: PrismaPlayerStatCreate[];

  beforeAll(() => {
    // Convert bootstrap players to domain player stats
    testPlayerStats = bootstrapData.elements
      .slice(0, 3)
      .map((player) => toDomainPlayerStat(player as ElementResponse));

    // Convert domain player stats to Prisma player stats
    testPrismaPlayerStats = testPlayerStats.map(toPrismaPlayerStat);
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await prisma.playerStat.deleteMany();
  });

  afterAll(async () => {
    // Final cleanup
    await prisma.playerStat.deleteMany();
    await prisma.$disconnect();
  });

  describe('Repository Operations', () => {
    // Simple comparison function that only checks unique identifiers
    const comparePlayerStat = (
      a: PrismaPlayerStat | PlayerStat,
      b: PrismaPlayerStatCreate | PrismaPlayerStat | PlayerStat,
    ): boolean => {
      return a.eventId === b.eventId && a.elementId === b.elementId;
    };

    it('should save a player stat', async () => {
      const repository = createPlayerStatRepository(prisma);
      const testPrismaPlayerStat = testPrismaPlayerStats[0];

      const saveResult = await pipe(repository.save(testPrismaPlayerStat))();
      expect(E.isRight(saveResult)).toBe(true);

      if (E.isRight(saveResult) && saveResult.right) {
        const validatedId = pipe(
          validatePlayerStatId(saveResult.right.id),
          E.getOrElseW(() => {
            throw new Error(`Invalid player stat ID: ${saveResult.right.id}`);
          }),
        );
        const findResult = await pipe(repository.findById(validatedId))();
        expect(E.isRight(findResult)).toBe(true);
        if (E.isRight(findResult) && findResult.right) {
          expect(comparePlayerStat(findResult.right, testPrismaPlayerStat)).toBe(true);
        }
      }
    });

    it('should handle duplicate save gracefully', async () => {
      const repository = createPlayerStatRepository(prisma);
      const testPrismaPlayerStat = testPrismaPlayerStats[0];

      // First save
      const saveResult1 = await pipe(repository.save(testPrismaPlayerStat))();
      expect(E.isRight(saveResult1)).toBe(true);

      // Second save of the same player stat
      const saveResult2 = await pipe(repository.save(testPrismaPlayerStat))();
      expect(E.isRight(saveResult2)).toBe(true);

      // Verify only one record exists
      const findAllResult = await pipe(repository.findAll())();
      expect(E.isRight(findAllResult)).toBe(true);
      if (E.isRight(findAllResult)) {
        expect(findAllResult.right.length).toBe(1);
        expect(comparePlayerStat(findAllResult.right[0], testPrismaPlayerStat)).toBe(true);
      }
    });

    it('should save multiple player stats', async () => {
      const repository = createPlayerStatRepository(prisma);

      const saveResult = await pipe(repository.saveBatch(testPrismaPlayerStats))();
      expect(E.isRight(saveResult)).toBe(true);

      const findResult = await pipe(repository.findAll())();
      expect(E.isRight(findResult)).toBe(true);
      if (E.isRight(findResult) && findResult.right) {
        expect(findResult.right.length).toBe(testPrismaPlayerStats.length);
        // Verify each stat exists by checking unique identifiers
        testPrismaPlayerStats.forEach((expected) => {
          const found = findResult.right.some((actual) => comparePlayerStat(actual, expected));
          expect(found).toBe(true);
        });
      }
    });

    it('should find a player stat by ID', async () => {
      const repository = createPlayerStatRepository(prisma);
      const testPrismaPlayerStat = testPrismaPlayerStats[0];

      // Save the player stat first
      const saveResult = await pipe(repository.save(testPrismaPlayerStat))();
      expect(E.isRight(saveResult)).toBe(true);

      if (E.isRight(saveResult) && saveResult.right) {
        const validatedId = pipe(
          validatePlayerStatId(saveResult.right.id),
          E.getOrElseW(() => {
            throw new Error(`Invalid player stat ID: ${saveResult.right.id}`);
          }),
        );
        const findResult = await pipe(repository.findById(validatedId))();
        expect(E.isRight(findResult)).toBe(true);
        if (E.isRight(findResult) && findResult.right) {
          expect(comparePlayerStat(findResult.right, testPrismaPlayerStat)).toBe(true);
        }
      }
    });

    it('should return null when finding non-existent player stat', async () => {
      const repository = createPlayerStatRepository(prisma);
      const nonExistentId = pipe(
        validatePlayerStatId('00000000-0000-0000-0000-000000000000'),
        E.getOrElseW(() => {
          throw new Error('Invalid player stat ID');
        }),
      );

      const findResult = await pipe(repository.findById(nonExistentId))();
      expect(E.isRight(findResult)).toBe(true);
      if (E.isRight(findResult)) {
        expect(findResult.right).toBeNull();
      }
    });

    it('should find all player stats', async () => {
      const repository = createPlayerStatRepository(prisma);

      // Save multiple player stats
      await pipe(repository.saveBatch(testPrismaPlayerStats))();

      const findResult = await pipe(repository.findAll())();
      expect(E.isRight(findResult)).toBe(true);
      if (E.isRight(findResult) && findResult.right) {
        expect(findResult.right.length).toBe(testPrismaPlayerStats.length);
        // Verify each stat exists by checking unique identifiers
        testPrismaPlayerStats.forEach((expected) => {
          const found = findResult.right.some((actual) => comparePlayerStat(actual, expected));
          expect(found).toBe(true);
        });
      }
    });

    it('should return empty array when no player stats exist', async () => {
      const repository = createPlayerStatRepository(prisma);

      const findResult = await pipe(repository.findAll())();
      expect(E.isRight(findResult)).toBe(true);
      if (E.isRight(findResult)) {
        expect(findResult.right).toEqual([]);
      }
    });

    it('should handle error cases gracefully', async () => {
      const repository = createPlayerStatRepository(prisma);
      const invalidPrismaPlayerStat = {
        ...testPrismaPlayerStats[0],
        id: 'invalid-uuid', // Invalid UUID format will trigger a database error
      };

      const saveResult = await pipe(repository.save(invalidPrismaPlayerStat))();
      expect(E.isLeft(saveResult)).toBe(true);
    });
  });
});
