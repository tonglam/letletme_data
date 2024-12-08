import * as E from 'fp-ts/Either';
import { EventOperations } from '../domains/events/operations';
import { EventRepository } from '../domains/events/repository';
import { EventUpdate, EventUpdateResult } from '../domains/events/types';

/**
 * Event service operations
 */
export const EventService = {
  /**
   * Update event with new values
   */
  updateEvent: async (update: EventUpdate): Promise<EventUpdateResult> => {
    try {
      // 1. Find existing event
      const existingEvent = await EventRepository.findById(update.id);
      if (!existingEvent) {
        return {
          success: false,
          error: `Event ${update.id} not found`,
        };
      }

      // 2. Validate update
      const validatedUpdate = EventOperations.validateUpdate(existingEvent, update);
      if (E.isLeft(validatedUpdate)) {
        return {
          success: false,
          error: validatedUpdate.left,
        };
      }

      // 3. Perform update
      await EventRepository.update(validatedUpdate.right);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
} as const;
