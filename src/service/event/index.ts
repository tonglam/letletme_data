// Event Service Entry Module
// Provides the main entry point for the event service layer.
// Handles service composition and dependency injection.

export { createEventService } from './service';
export type {
  EventService,
  EventServiceDependencies,
  EventServiceOperations,
  EventServiceWithWorkflows,
  WorkflowContext,
  WorkflowResult,
} from './types';
export { EventWorkflows } from './workflow';
