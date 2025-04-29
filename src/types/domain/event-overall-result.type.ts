import { ChipPlay, EventId, TopElementInfo } from 'types/domain/event.type';

export type EventOverallResult = {
  eventId: EventId;
  averageEntryScore: number;
  finished: boolean;
  highestScoringEntry: number;
  highestScore: number;
  chipPlays: ChipPlay[];
  mostSelected: number;
  mostSelectedWebName: string;
  mostTransferredIn: number;
  mostTransferredInWebName: string;
  mostCaptained: number;
  mostCaptainedWebName: string;
  mostViceCaptained: number;
  mostViceCaptainedWebName: string;
  topElement: number;
  topElementInfo: TopElementInfo;
  transfersMade: number;
};

export type EventOverallResults = readonly EventOverallResult[];

export type RawEventOverallResult = Omit<
  EventOverallResult,
  | 'mostSelectedWebName'
  | 'mostTransferredInWebName'
  | 'mostCaptainedWebName'
  | 'mostViceCaptainedWebName'
>;

export type RawEventOverallResults = readonly RawEventOverallResult[];
