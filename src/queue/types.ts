import { BaseJobData } from '../types/queue.type';
import { EventsJobService } from './meta/event/event.service';

export interface MetaService {
  readonly eventsService: EventsJobService;
  readonly cleanup: () => Promise<void>;
}

export interface MetaJobData extends BaseJobData {
  readonly type: 'META';
  readonly timestamp: Date;
  readonly data: {
    readonly operation: string;
    readonly type: string;
  };
}
