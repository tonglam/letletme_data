import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { mockDeep, mockReset } from 'jest-mock-extended';
import { join } from 'path';
import { createPlayerRepository } from '../../src/domain/player/repository';
import { Player, PlayerId, toDomainPlayer, toPrismaPlayer } from '../../src/domain/player/types';
import { ElementResponse, ElementResponseSchema } from '../../src/types/element.type';

// Create a mock PrismaClient
const prisma = mockDeep<PrismaClient>();

// Load test data directly from JSON
const loadTestPlayers = (): ElementResponse[] => {
  const filePath = join(__dirname, '../data/bootstrap.json');
  const fileContent = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);
  // Parse and validate the first 3 elements
  return data.elements.slice(0, 3).map((element: unknown) => ElementResponseSchema.parse(element));
};

// Add createdAt to Prisma model
const addCreatedAt = <T extends object>(data: T) => ({
  ...data,
  createdAt: new Date(),
});

describe('Player Repository', () => {
  const playerRepository = createPlayerRepository(prisma);
  let testPlayers: Player[];
  const createdPlayerIds: number[] = [];

  beforeAll(() => {
    // Convert test data to domain models
    const players = loadTestPlayers();
    testPlayers = players.map((player: ElementResponse) => toDomainPlayer(player));
  });

  beforeEach(() => {
    mockReset(prisma);
  });

  describe('save', () => {
    it('should save a player', async () => {
      const player = testPlayers[0];
      const prismaPlayer = addCreatedAt(toPrismaPlayer(player));
      prisma.player.create.mockResolvedValue(prismaPlayer);

      const result = await playerRepository.save(toPrismaPlayer(player))();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.element).toBe(player.id);
        expect(result.right.webName).toBe(player.webName);
        expect(result.right.elementCode).toBe(player.elementCode);
        expect(result.right.price).toBe(player.price);
        createdPlayerIds.push(Number(player.id));
      }
    });

    it('should handle duplicate player save', async () => {
      const player = testPlayers[0];
      prisma.player.create.mockRejectedValue(new Error('Unique constraint failed'));

      const result = await playerRepository.save(toPrismaPlayer(player))();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.code).toBe('QUERY_ERROR');
      }
    });
  });

  describe('saveBatch', () => {
    it('should save multiple players', async () => {
      const prismaPlayers = testPlayers.map((player) => addCreatedAt(toPrismaPlayer(player)));
      prisma.player.createMany.mockResolvedValue({ count: prismaPlayers.length });
      prisma.player.findMany.mockResolvedValue(prismaPlayers);

      const result = await playerRepository.saveBatch(testPlayers.map(toPrismaPlayer))();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(testPlayers.length);
        result.right.forEach((player, index) => {
          expect(player.element).toBe(testPlayers[index].id);
          expect(player.webName).toBe(testPlayers[index].webName);
          createdPlayerIds.push(Number(player.element));
        });
      }
    });
  });

  describe('findById', () => {
    it('should find player by id', async () => {
      const player = testPlayers[0];
      prisma.player.findUnique.mockResolvedValue(addCreatedAt(toPrismaPlayer(player)));

      const result = await playerRepository.findById(player.id)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right?.element).toBe(player.id);
        expect(result.right?.webName).toBe(player.webName);
      }
    });

    it('should return null for non-existent player', async () => {
      const nonExistentId = 999999 as PlayerId;
      prisma.player.findUnique.mockResolvedValue(null);

      const result = await playerRepository.findById(nonExistentId)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('findAll', () => {
    it('should find all players', async () => {
      const prismaPlayers = testPlayers.map((player) => addCreatedAt(toPrismaPlayer(player)));
      prisma.player.findMany.mockResolvedValue(prismaPlayers);

      const result = await playerRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(testPlayers.length);
        result.right.forEach((player, index) => {
          expect(player.element).toBe(testPlayers[index].id);
          expect(player.webName).toBe(testPlayers[index].webName);
        });
      }
    });

    it('should return empty array when no players exist', async () => {
      prisma.player.findMany.mockResolvedValue([]);

      const result = await playerRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(0);
      }
    });
  });

  describe('deleteAll', () => {
    it('should delete all players', async () => {
      prisma.player.deleteMany.mockResolvedValue({ count: 0 });
      prisma.player.findMany.mockResolvedValue([]);

      const result = await playerRepository.deleteAll()();

      expect(result._tag).toBe('Right');
      const findResult = await playerRepository.findAll()();
      expect(findResult._tag).toBe('Right');
      if (findResult._tag === 'Right') {
        expect(findResult.right).toHaveLength(0);
      }
    });
  });
});
