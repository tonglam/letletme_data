// Service Exports Module
// Provides centralized exports for all application services.

import type { EventService } from './events';

// Service keys for type-safe access
export const ServiceKey = {
  EVENT: 'eventService',
} as const;

// Service container interface
export interface ServiceContainer {
  readonly [ServiceKey.EVENT]: EventService;
}

export type { EventService } from './events';
