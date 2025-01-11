import { readFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createPlayerValueRepository } from '../../src/domain/player-value/repository';
import {
  PlayerValue,
  PlayerValueId,
  PrismaPlayerValue,
  toPrismaPlayerValue,
} from '../../src/domain/player-value/types';
import { prisma } from '../../src/infrastructure/db/prisma';
import {
  ElementType,
  ElementTypeConfig,
  ValueChangeType,
  getElementTypeById,
} from '../../src/types/base.type';
import { ElementResponse } from '../../src/types/element.type';

// Load test data directly from JSON
const loadTestPlayerValues = (): ElementResponse[] => {
  const filePath = join(__dirname, '../data/bootstrap.json');
  const fileContent = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);
  return data.elements;
};

describe('Player Value Repository', () => {
  const playerValueRepository = createPlayerValueRepository(prisma);
  let testPlayerValues: PlayerValue[];
  const createdPlayerValueIds: string[] = [];

  beforeAll(() => {
    // Convert test data to domain models and add necessary fields
    const players = loadTestPlayerValues().slice(0, 3);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    testPlayerValues = players.map((player: ElementResponse) => ({
      id: uuidv4() as PlayerValueId,
      elementId: player.id,
      elementType: getElementTypeById(player.element_type) ?? ElementType.GKP,
      eventId: 1, // Using a default event ID for testing
      value: player.now_cost,
      changeDate: today,
      changeType: ValueChangeType.Start,
      lastValue: player.now_cost,
    }));
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await prisma.playerValue.deleteMany();
  });

  afterAll(async () => {
    // Clean up test data
    if (createdPlayerValueIds.length > 0) {
      await prisma.playerValue.deleteMany({
        where: {
          id: {
            in: createdPlayerValueIds,
          },
        },
      });
    }
    await prisma.$disconnect();
  });

  describe('save', () => {
    it('should save a player value', async () => {
      const playerValue = testPlayerValues[0];
      const result = await playerValueRepository.save(toPrismaPlayerValue(playerValue))();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.elementId).toBe(playerValue.elementId);
        expect(result.right.value).toBe(playerValue.value);
        expect(result.right.changeDate).toBe(playerValue.changeDate);
        expect(result.right.changeType).toBe(playerValue.changeType);
        createdPlayerValueIds.push(result.right.id);
      }
    });

    it('should handle duplicate player value save', async () => {
      const playerValue = testPlayerValues[0];
      await playerValueRepository.save(toPrismaPlayerValue(playerValue))();
      const result = await playerValueRepository.save(toPrismaPlayerValue(playerValue))();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.code).toBe('QUERY_ERROR');
      }
    });
  });

  describe('saveBatch', () => {
    it('should save multiple player values', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      const result = await playerValueRepository.saveBatch(prismaPlayerValues)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(testPlayerValues.length);
        result.right.forEach((playerValue, index) => {
          expect(playerValue.elementId).toBe(testPlayerValues[index].elementId);
          expect(playerValue.value).toBe(testPlayerValues[index].value);
          createdPlayerValueIds.push(playerValue.id);
        });
      }
    });
  });

  describe('findById', () => {
    it('should find player value by id', async () => {
      const playerValue = testPlayerValues[0];
      const saved = await playerValueRepository.save(toPrismaPlayerValue(playerValue))();
      if (saved._tag !== 'Right') throw new Error('Failed to save player value');

      const result = await playerValueRepository.findById(saved.right.id as PlayerValueId)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right?.elementId).toBe(playerValue.elementId);
        expect(result.right?.value).toBe(playerValue.value);
      }
    });

    it('should return null for non-existent player value', async () => {
      const nonExistentId = uuidv4() as PlayerValueId;
      const result = await playerValueRepository.findById(nonExistentId)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('findAll', () => {
    it('should find all player values', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      await playerValueRepository.saveBatch(prismaPlayerValues)();
      const result = await playerValueRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(prismaPlayerValues.length);
        result.right.forEach((playerValue) => {
          const matchingTestValue = testPlayerValues.find(
            (tv) => tv.elementId === playerValue.elementId,
          );
          expect(matchingTestValue).toBeDefined();
          if (matchingTestValue) {
            expect(playerValue.value).toBe(matchingTestValue.value);
          }
        });
      }
    });

    it('should return empty array when no player values exist', async () => {
      const result = await playerValueRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(0);
      }
    });
  });

  describe('findByChangeDate', () => {
    it('should find player values by change date', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      await playerValueRepository.saveBatch(prismaPlayerValues)();
      const changeDate = testPlayerValues[0].changeDate;
      const result = await playerValueRepository.findByChangeDate(changeDate)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.length).toBeGreaterThan(0);
        result.right.forEach((playerValue) => {
          expect(playerValue.changeDate).toBe(changeDate);
        });
      }
    });
  });

  describe('findByElementId', () => {
    it('should find player values by element id', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      await playerValueRepository.saveBatch(prismaPlayerValues)();
      const elementId = testPlayerValues[0].elementId;
      const result = await playerValueRepository.findByElementId(elementId)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.length).toBeGreaterThan(0);
        result.right.forEach((playerValue: PrismaPlayerValue) => {
          expect(playerValue.elementId).toBe(elementId);
        });
      }
    });
  });

  describe('findByElementType', () => {
    it('should find player values by element type', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      await playerValueRepository.saveBatch(prismaPlayerValues)();
      const elementType = ElementTypeConfig[testPlayerValues[0].elementType].id;
      const result = await playerValueRepository.findByElementType(elementType)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.length).toBeGreaterThan(0);
        result.right.forEach((playerValue) => {
          expect(playerValue.elementType).toBe(elementType);
        });
      }
    });
  });

  describe('findByChangeType', () => {
    it('should find player values by change type', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      await playerValueRepository.saveBatch(prismaPlayerValues)();
      const changeType = testPlayerValues[0].changeType;
      const result = await playerValueRepository.findByChangeType(changeType)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.length).toBeGreaterThan(0);
        result.right.forEach((playerValue) => {
          expect(playerValue.changeType).toBe(changeType);
        });
      }
    });
  });

  describe('findByEventId', () => {
    it('should find player values by event id', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      await playerValueRepository.saveBatch(prismaPlayerValues)();
      const eventId = testPlayerValues[0].eventId;
      const result = await playerValueRepository.findByEventId(eventId)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.length).toBeGreaterThan(0);
        result.right.forEach((playerValue) => {
          expect(playerValue.eventId).toBe(eventId);
        });
      }
    });
  });

  describe('findLatestByElements', () => {
    it('should find latest player values for each element', async () => {
      // Create test data with multiple values per element
      const elementId = testPlayerValues[0].elementId;
      const olderDate = '20230101';
      const newerDate = '20230102';

      const olderValue = {
        ...testPlayerValues[0],
        changeDate: olderDate,
        value: 50,
      };

      const newerValue = {
        ...testPlayerValues[0],
        changeDate: newerDate,
        value: 60,
      };

      // Save both values
      await playerValueRepository.saveBatch([
        toPrismaPlayerValue(olderValue),
        toPrismaPlayerValue(newerValue),
      ])();

      const result = await playerValueRepository.findLatestByElements()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        // Should only get one value per element (the latest)
        const valuesForElement = result.right.filter((pv) => pv.elementId === elementId);
        expect(valuesForElement).toHaveLength(1);

        // Should be the newer value
        const latestValue = valuesForElement[0];
        expect(latestValue.changeDate).toBe(newerDate);
        expect(latestValue.value).toBe(60);
      }
    });

    it('should handle empty database', async () => {
      const result = await playerValueRepository.findLatestByElements()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(0);
      }
    });
  });

  describe('deleteAll', () => {
    it('should delete all player values', async () => {
      const prismaPlayerValues = testPlayerValues.map(toPrismaPlayerValue);
      await playerValueRepository.saveBatch(prismaPlayerValues)();
      const result = await playerValueRepository.deleteAll()();

      expect(result._tag).toBe('Right');
      const findResult = await playerValueRepository.findAll()();
      expect(findResult._tag).toBe('Right');
      if (findResult._tag === 'Right') {
        expect(findResult.right).toHaveLength(0);
      }
    });
  });
});
