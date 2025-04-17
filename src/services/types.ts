import type { EventService } from './event/types';
import type { PhaseService } from './phase/types';
import type { PlayerService } from './player/types';
import type { PlayerStatService } from './player-stat/types';
import type { PlayerValueService } from './player-value/types';
import type { TeamService } from './team/types';

export const ServiceKey = {
  EVENT: 'event',
  PHASE: 'phase',
  PLAYER: 'player',
  PLAYER_STAT: 'player-stat',
  PLAYER_VALUE: 'player-value',
  TEAM: 'team',
} as const;

export interface ServiceContainer {
  readonly eventService: EventService;
  readonly phaseService: PhaseService;
  readonly playerService: PlayerService;
  readonly playerStatService: PlayerStatService;
  readonly playerValueService: PlayerValueService;
  readonly teamService: TeamService;
}

export interface WorkflowContext {
  readonly workflowId: string;
  readonly startTime: Date;
}

export interface WorkflowResult<T> {
  readonly context: WorkflowContext;
  readonly result: T;
  readonly duration: number;
}

export const createWorkflowContext = (workflowId: string): WorkflowContext => ({
  workflowId,
  startTime: new Date(),
});
