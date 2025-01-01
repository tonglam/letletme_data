import { BaseJobData, JobOperation, JobType, MetaJobType } from './queue.type';

// Meta Job Data
export interface MetaJobData extends BaseJobData {
  readonly type: JobType;
  readonly data: {
    readonly operation: JobOperation;
    readonly type: MetaJobType;
  };
}

// Events Job Data
export interface EventsJobData extends MetaJobData {
  readonly data: {
    readonly operation: JobOperation;
    readonly type: MetaJobType;
  };
}

// Live Job Data
export interface LiveJobData extends BaseJobData {
  readonly type: JobType;
  readonly data: {
    readonly matchId?: number;
    readonly gameweek?: number;
  };
}

// Daily Job Data
export interface DailyJobData extends BaseJobData {
  readonly type: JobType;
  readonly data: {
    readonly date: string;
    readonly options?: Record<string, unknown>;
  };
}

// Union type for all job data types
export type JobData = MetaJobData | LiveJobData | DailyJobData;
