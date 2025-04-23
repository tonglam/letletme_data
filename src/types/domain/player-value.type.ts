import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';

import { ElementTypeId, ElementTypeName, ValueChangeType } from '../base.type';
import { TeamId } from './team.type';

export interface PlayerValue {
  readonly elementId: PlayerId;
  readonly webName: string;
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
  'webName' | 'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName'
>;
export type RawPlayerValues = readonly RawPlayerValue[];

export type SourcePlayerValue = Omit<RawPlayerValue, 'changeType' | 'lastValue'>;
export type SourcePlayerValues = readonly SourcePlayerValue[];

export type PlayerValueChange = Omit<
  PlayerValue,
  'webName' | 'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName'
>;
export type PlayerValueChanges = readonly PlayerValueChange[];
