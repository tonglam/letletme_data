import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';
import { EventQueries } from '../domains/events/queries';
import { PlayerValueOperations } from '../domains/players/operations';
import { PlayerValueRepository } from '../domains/players/repository';
import { PlayerValueResponse, PlayerValueResponseSchema } from '../domains/players/types';
import { BootStrap } from '../infrastructure/bootstrap/types';
import { validateData } from '../infrastructure/validation';

/**
 * Player value service operations
 */
export const PlayerValueService = {
  /**
   * Upsert player values from bootstrap data
   */
  upsertPlayerValues: async (bootStrapData: BootStrap): Promise<void> => {
    // Validate data
    const validatedData = await validateData(bootStrapData.elements, PlayerValueResponseSchema);

    // Get current event
    const currentEvent = EventQueries.getCurrent(bootStrapData.events);
    if (!currentEvent.isValid) {
      throw new Error('No current event found');
    }

    // Get latest values
    const lastValuesMap = await PlayerValueRepository.getLatestValuesByElement();

    // Transform data
    const playerValues = pipe(
      validatedData,
      A.filterMap((data: PlayerValueResponse) =>
        PlayerValueOperations.transformToPlayerValue(
          data,
          lastValuesMap.get(data.id) ?? 0,
          currentEvent.currentEventId,
        ),
      ),
    );

    // Delete old data and insert new
    await PlayerValueRepository.deleteAll();
    await PlayerValueRepository.createMany(playerValues);
  },
} as const;
