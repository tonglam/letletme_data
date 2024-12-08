import { PlayerValueRepository } from '../../../src/domains/players/repository';
import { PlayerValue } from '../../../src/domains/players/types';
import { prisma } from '../../../src/infrastructure/db/prisma';

jest.mock('../../../src/infrastructure/db/prisma', () => ({
  prisma: {
    playerValue: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  },
}));

describe('PlayerValueRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getLatestValuesByElement', () => {
    it('should return a map of latest values', async () => {
      const mockValues = [
        { elementId: 1, value: 100 },
        { elementId: 2, value: 200 },
      ];

      (prisma.playerValue.findMany as jest.Mock).mockResolvedValue(mockValues);

      const result = await PlayerValueRepository.getLatestValuesByElement();
      expect(result).toBeInstanceOf(Map);
      expect(result.get(1)).toBe(100);
      expect(result.get(2)).toBe(200);
    });
  });

  describe('deleteAll', () => {
    it('should call deleteMany', async () => {
      await PlayerValueRepository.deleteAll();
      expect(prisma.playerValue.deleteMany).toHaveBeenCalled();
    });
  });

  describe('createMany', () => {
    it('should create multiple player values', async () => {
      const mockValues: ReadonlyArray<PlayerValue> = [
        {
          elementId: 1,
          elementType: 1,
          eventId: 1,
          value: 100,
          lastValue: 90,
          changeDate: '2023-12-07',
          changeType: 'Rise',
        },
      ];

      await PlayerValueRepository.createMany(mockValues);
      expect(prisma.playerValue.createMany).toHaveBeenCalledWith({
        data: mockValues,
      });
    });
  });
});
