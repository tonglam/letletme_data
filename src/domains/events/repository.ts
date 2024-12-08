import { prisma } from '../../infrastructure/db/prisma';
import { EventDeadline } from './types';

/**
 * Event repository operations
 */
export const EventRepository = {
  /**
   * Find event by ID
   */
  findById: async (id: number): Promise<EventDeadline | null> => {
    const event = await prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        deadlineTime: true,
        deadlineTimeEpoch: true,
      },
    });

    if (!event) return null;

    return {
      id: event.id,
      deadlineTime: event.deadlineTime.toISOString(),
      deadlineTimeEpoch: event.deadlineTimeEpoch,
    };
  },

  /**
   * Update event
   */
  update: async (event: EventDeadline): Promise<EventDeadline> => {
    const updated = await prisma.event.update({
      where: { id: event.id },
      data: {
        deadlineTime: new Date(event.deadlineTime),
        deadlineTimeEpoch: event.deadlineTimeEpoch,
      },
      select: {
        id: true,
        deadlineTime: true,
        deadlineTimeEpoch: true,
      },
    });

    return {
      id: updated.id,
      deadlineTime: updated.deadlineTime.toISOString(),
      deadlineTimeEpoch: updated.deadlineTimeEpoch,
    };
  },
} as const;
