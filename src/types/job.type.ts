// Define valid job names as a union type
export type JobName =
  | 'scheduler'
  | 'flow'
  | 'worker'
  | 'meta'
  | 'live'
  | 'daily'
  | 'events'
  | 'phases'
  | 'teams';

// Base job data interface with name field
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
  readonly name: JobName; // Required for BullMQ v5 compatibility
}

// Specific job data interface
export interface JobData extends BaseJobData {
  readonly type: 'META' | 'LIVE' | 'DAILY' | 'EVENTS' | 'PHASES' | 'TEAMS';
  readonly name: JobName;
}

// Meta Job specific types
export type MetaOperation = 'SYNC' | 'CLEANUP';
export type MetaType = 'EVENTS' | 'PHASES' | 'TEAMS';

export interface MetaJobData extends BaseJobData {
  readonly type: 'META';
  readonly name: 'meta';
  readonly data: {
    readonly operation: MetaOperation;
    readonly metaType: MetaType;
    readonly payload?: unknown;
  };
}

// Event Job specific types
export interface EventMetaData {
  readonly eventId: string;
  readonly seasonId: string;
  readonly leagueId: string;
}

export interface EventJobData extends BaseJobData {
  readonly type: 'EVENTS';
  readonly name: 'events';
  readonly data: {
    readonly operation: MetaOperation;
    readonly payload: EventMetaData;
  };
}

// Phase Job specific types
export interface PhaseMetaData {
  readonly phaseId: string;
  readonly eventId: string;
  readonly seasonId: string;
}

export interface PhaseJobData extends BaseJobData {
  readonly type: 'PHASES';
  readonly name: 'phases';
  readonly data: {
    readonly operation: MetaOperation;
    readonly payload: PhaseMetaData;
  };
}

// Team Job specific types
export interface TeamMetaData {
  readonly teamId: string;
  readonly eventId: string;
  readonly phaseId?: string;
}

export interface TeamJobData extends BaseJobData {
  readonly type: 'TEAMS';
  readonly name: 'teams';
  readonly data: {
    readonly operation: MetaOperation;
    readonly payload: TeamMetaData;
  };
}

// Type guard to check if a string is a valid job name
export const isJobName = (name: string): name is JobName => {
  return [
    'scheduler',
    'flow',
    'worker',
    'meta',
    'live',
    'daily',
    'events',
    'phases',
    'teams',
  ].includes(name);
};

// Meta Queue Service types
import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { QueueService } from '../infrastructure/queue/types';
import { QueueError } from './errors.type';

export interface MetaQueueService extends QueueService<MetaJobData> {
  readonly processJob: (job: Job<MetaJobData>) => TE.TaskEither<QueueError, void>;
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
  readonly syncMeta: (metaType: MetaType) => TE.TaskEither<QueueError, void>;
  readonly cleanupMeta: (metaType: MetaType) => TE.TaskEither<QueueError, void>;
}

export interface MetaService {
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
  readonly cleanup: () => TE.TaskEither<QueueError, void>;
}

export interface EventMetaService extends MetaService {
  readonly syncEvent: (eventData: EventMetaData) => TE.TaskEither<QueueError, void>;
}

// Event Service types

export interface EventRepository {
  readonly syncEvent: (eventData: EventMetaData) => TE.TaskEither<QueueError, void>;
}

export interface EventWorkerService {
  readonly start: () => TE.TaskEither<QueueError, void>;
  readonly stop: () => TE.TaskEither<QueueError, void>;
}
