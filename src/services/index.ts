/**
 * Service Exports Module
 *
 * Provides centralized exports for all application services.
 * @module Services
 */

import type { EventService } from './events/types';

// Event Service
export { createEventService } from './events';
export type { EventService } from './events/types';

/** Container for all application services */
export interface ServiceContainer {
  readonly eventService: EventService;
}
