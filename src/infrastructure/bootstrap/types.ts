import { EventDeadline } from '../../domains/events/types';
import { PlayerValueResponse } from '../../domains/players/types';

/**
 * Bootstrap data from API
 */
export interface BootStrap {
  readonly events: ReadonlyArray<EventDeadline>;
  readonly elements: ReadonlyArray<PlayerValueResponse>;
  // Add other bootstrap data types as needed
}
