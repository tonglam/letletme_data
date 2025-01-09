// Define valid job names
export type JobName = 'meta';

// Base job data interface
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
  readonly name: JobName;
}

// Meta Job specific types
export type MetaOperation = 'SYNC';
export type MetaType = 'EVENTS' | 'PHASES' | 'TEAMS';

export interface MetaJobData extends BaseJobData {
  readonly type: 'META';
  readonly name: 'meta';
  readonly data: {
    readonly operation: MetaOperation;
    readonly metaType: MetaType;
  };
}

// Generic job data type
export type JobData = MetaJobData;

// Type guard for job name
export const isJobName = (name: string): name is JobName => name === 'meta';

// Meta Queue Service types
import * as TE from 'fp-ts/TaskEither';
import { QueueService } from '../infrastructure/queue/types';
import { QueueError } from './error.type';

export interface MetaQueueService extends QueueService<MetaJobData> {}

export interface MetaService {
  readonly syncMeta: (metaType: MetaType) => TE.TaskEither<QueueError, void>;
}

export interface EventMetaService extends MetaService {
  readonly syncEvents: () => TE.TaskEither<QueueError, void>;
}

export interface PhaseMetaService extends MetaService {
  readonly syncPhases: () => TE.TaskEither<QueueError, void>;
}
