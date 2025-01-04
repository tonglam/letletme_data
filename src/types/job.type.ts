export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
}

export interface JobData extends BaseJobData {
  readonly type: 'META' | 'LIVE' | 'DAILY' | 'EVENTS' | 'PHASES' | 'TEAMS';
}
