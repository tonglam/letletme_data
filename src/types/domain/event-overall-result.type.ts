import { ChipPlay, TopElementInfo } from 'src/types/domain/event.type';

export type EventOverallResult = {
  eventId: string;
  averageEntryScore: number;
  finished: boolean;
  highestScoringEntry: number;
  highestScore: number;
  chipPlays: ChipPlay[];
  mostSelected: number;
  mostSelectedWebName: string;
  mostTransferredIn: number;
  mostTransferredInWebName: string;
  topElementInfo: TopElementInfo;
  transfersMade: number;
  mostCaptained: number;
  mostCaptainedWebName: string;
  mostViceCaptained: number;
  mostViceCaptainedWebName: string;
};

export type EventOverallResults = readonly EventOverallResult[];
