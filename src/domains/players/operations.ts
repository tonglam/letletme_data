import { format } from 'date-fns';
import * as O from 'fp-ts/Option';
import { PlayerValue, PlayerValueChangeType, PlayerValueResponse } from './types';

/**
 * Player value operations
 */
export const PlayerValueOperations = {
  /**
   * Transform API response to domain model
   */
  transformToPlayerValue: (
    data: PlayerValueResponse,
    lastValue: number,
    currentEventId: number,
  ): O.Option<PlayerValue> => {
    if (lastValue === data.now_cost) {
      return O.none;
    }

    const changeType: PlayerValueChangeType =
      lastValue === 0 ? 'Start' : data.now_cost > lastValue ? 'Rise' : 'Fall';

    return O.some({
      elementId: data.id,
      elementType: data.element_type,
      eventId: currentEventId,
      value: data.now_cost,
      changeDate: format(new Date(), 'yyyy-MM-dd'),
      changeType,
      lastValue,
    });
  },
} as const;
