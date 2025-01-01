import { JobType } from '../types/queue.type';
import { EventsJobService } from './jobs/meta/events/events.service';

export type MetaJobType = 'EVENTS' | 'CLEANUP';
export type MetaJobOperation = 'SYNC' | 'CLEANUP';

export interface MetaJobData {
  readonly type: JobType.META;
  readonly timestamp: Date;
  readonly data: {
    readonly operation: MetaJobOperation;
    readonly type: MetaJobType;
  };
}

export interface MetaService {
  readonly eventsService: EventsJobService;
  readonly cleanup: () => Promise<void>;
}
