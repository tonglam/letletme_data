import { EventID } from '@app/domain/types/id.types';
import { ChipPlays } from '@app/domain/value-objects/chip-play.types';
import { TopElementInfo } from '@app/infrastructure/external/fpl/schemas/bootstrap/event.schema';

export type EventModel = {
  readonly id: EventID;
  readonly name: string;
  readonly deadlineTime: string;
  readonly finished: boolean;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly averageEntryScore: number;
  readonly dataChecked: boolean;
  readonly highestScore: number;
  readonly highestScoringEntry: number;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly transfersMade: number;
  readonly rankedCount: number;
  readonly chipPlays: ChipPlays;
  readonly mostSelected: number;
  readonly mostTransferredIn: number;
  readonly mostCaptained: number;
  readonly mostViceCaptained: number;
  readonly topElement: number;
  readonly topElementInfo: TopElementInfo;
};

export type EventsModel = readonly EventModel[];
