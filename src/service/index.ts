// Service Exports Module
// Provides centralized exports for all application services.

import type { EventService } from './event';
import type { EventWorkflows } from './event/workflow';
import type { PhaseService } from './phase';
import type { PlayerService } from './player';
import type { PlayerStatService } from './player-stat';
import type { PlayerValueService } from './player-value';
import type { TeamService } from './team';

// Service keys for type-safe access
export const ServiceKey = {
  EVENT: 'eventService',
  PHASE: 'phaseService',
  PLAYER: 'playerService',
  PLAYER_STAT: 'playerStatService',
  PLAYER_VALUE: 'playerValueService',
  TEAM: 'teamService',
} as const;

// Workflow keys for type-safe access
export const WorkflowKey = {
  EVENT: 'eventWorkflows',
} as const;

// Service container interface
export interface ServiceContainer {
  readonly [ServiceKey.EVENT]: EventService;
  readonly [ServiceKey.PHASE]: PhaseService;
  readonly [ServiceKey.PLAYER]: PlayerService;
  readonly [ServiceKey.PLAYER_STAT]: PlayerStatService;
  readonly [ServiceKey.PLAYER_VALUE]: PlayerValueService;
  readonly [ServiceKey.TEAM]: TeamService;
}

// Workflow container interface
export interface WorkflowContainer {
  readonly [WorkflowKey.EVENT]: EventWorkflows;
}

// Application container combining services and workflows
export interface ApplicationContainer extends ServiceContainer, WorkflowContainer {}
