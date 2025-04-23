import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';

import { ElementTypeId, ElementTypeName, ValueChangeType } from '../base.type';
import { TeamId } from './team.type';

export interface PlayerValue {
  readonly elementId: PlayerId;
  readonly elementType: ElementTypeId;
  readonly elementTypeName: ElementTypeName;
  readonly eventId: EventId;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
}

export type PlayerValues = readonly PlayerValue[];

export type RawPlayerValue = Omit<
  PlayerValue,
  'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName'
>;
export type RawPlayerValues = readonly RawPlayerValue[];

export type PlayerValueChange = Omit<
  PlayerValue,
  'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName'
>;
export type PlayerValueChanges = readonly PlayerValueChange[];
