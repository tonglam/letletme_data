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
