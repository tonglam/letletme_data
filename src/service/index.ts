// Service Exports Module
// Provides centralized exports for all application services.

import type { EventService } from './event';
import type { EventWorkflows } from './event/workflow';
import type { PhaseService } from './phase';

// Service keys for type-safe access
export const ServiceKey = {
  EVENT: 'eventService',
  PHASE: 'phaseService',
} as const;

// Workflow keys for type-safe access
export const WorkflowKey = {
  EVENT: 'eventWorkflows',
} as const;

// Service container interface
export interface ServiceContainer {
  readonly [ServiceKey.EVENT]: EventService;
  readonly [ServiceKey.PHASE]: PhaseService;
}

// Workflow container interface
export interface WorkflowContainer {
  readonly [WorkflowKey.EVENT]: EventWorkflows;
}

// Application container combining services and workflows
export interface ApplicationContainer extends ServiceContainer, WorkflowContainer {}

// Re-export service types
export type { EventService } from './event';
export type { EventWorkflows } from './event/workflow';
