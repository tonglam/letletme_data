import { EventID, PlayerID, TeamID } from '@app/domain/shared/types/id.types';
import { PlayerTypeID, PlayerTypeName, ValueChangeType } from '@app/domain/shared/types/type.types';

export interface PlayerValueModel {
  readonly elementId: PlayerID;
  readonly webName: string;
  readonly elementType: PlayerTypeID;
  readonly elementTypeName: PlayerTypeName;
  readonly eventId: EventID;
  readonly teamId: TeamID;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
}
