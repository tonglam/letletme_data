import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/db/prisma';
import { PlayerValue } from './types';

/**
 * Maps domain model to Prisma input
 */
const toPrisma = (value: PlayerValue): Prisma.PlayerValueCreateManyInput => ({
  elementId: value.elementId,
  elementType: value.elementType,
  eventId: value.eventId,
  value: value.value,
  lastValue: value.lastValue,
  changeDate: value.changeDate,
  changeType: value.changeType,
});

/**
 * Player value repository operations
 */
export const PlayerValueRepository = {
  /**
   * Get latest player values by element
   */
  getLatestValuesByElement: async (): Promise<Map<number, number>> => {
    const latestValues = await prisma.playerValue.findMany({
      orderBy: { createdAt: 'desc' },
      distinct: ['elementId'],
      select: {
        elementId: true,
        value: true,
      },
    });

    return new Map(
      latestValues.map((value) => [value.elementId, value.value])
    );
  },

  /**
   * Delete all player values
   */
  deleteAll: async (): Promise<void> => {
    await prisma.playerValue.deleteMany();
  },

  /**
   * Create many player values
   */
  createMany: async (values: ReadonlyArray<PlayerValue>): Promise<void> => {
    await prisma.playerValue.createMany({
      data: Array.from(values).map(toPrisma),
    });
  },
} as const;

</```
rewritten_file>