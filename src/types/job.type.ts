import { JobType, MetaJobType } from './queue.type';

export interface JobData {
  readonly type: JobType | MetaJobType;
  readonly timestamp: Date;
  readonly data: unknown;
}

// Helper type for BullMQ compatibility
export type ExtractJobData<T> = T extends JobData
  ? {
      readonly type: T['type'];
      readonly timestamp: Date;
      readonly data: T['data'];
    }
  : never;
