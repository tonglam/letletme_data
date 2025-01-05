// Event Service Entry Module
// Provides the main entry point for the event service layer.
// Handles service composition and dependency injection.

import { ExtendedBootstrapApi } from 'domains/bootstrap/types';
import { EventRepositoryOperations } from '../../domain/event/types';
import { createEventService as createEventServiceImpl } from './service';
import type { EventService } from './types';
import type { EventWorkflows } from './workflow';
import { eventWorkflows } from './workflow';

// Event workflow keys for type-safe access
export const EventWorkflowKey = {
  SYNC: 'syncEvents',
} as const;

// Create core event service
export const createEventService = (
  bootstrapApi: ExtendedBootstrapApi,
  repository: EventRepositoryOperations,
): EventService => createEventServiceImpl(bootstrapApi, repository);

// Create event workflows
export const createEventWorkflows = (service: EventService): EventWorkflows =>
  eventWorkflows(service);

// Re-export types
export type { EventService } from './types';
export type { EventWorkflows } from './workflow';
