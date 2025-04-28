import { Chip, ElementTypeId, ElementTypeName } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

export type PickItem = {
  readonly elementId: PlayerId;
  readonly webName: string;
  readonly position: number;
  readonly multiplier: number;
  readonly isCaptain: boolean;
  readonly isViceCaptain: boolean;
  readonly elementType: ElementTypeId;
  readonly elementTypeName: ElementTypeName;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
};

export type EntryEventPick = {
  readonly entryId: EntryId;
  readonly entryName: string;
  readonly eventId: EventId;
  readonly chip: Chip;
  readonly picks: readonly PickItem[];
  readonly transfers: number;
  readonly transfersCost: number;
};

export type EntryEventPicks = readonly EntryEventPick[];

export type RawPickItem = Omit<
  PickItem,
  'webName' | 'elementType' | 'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName' | 'value'
>;
export type RawPickItems = readonly RawPickItem[];

export type RawEntryEventPick = {
  readonly entryId: EntryId;
  readonly eventId: EventId;
  readonly chip: Chip;
  readonly picks: readonly RawPickItem[];
  readonly transfers: number;
  readonly transfersCost: number;
};
export type RawEntryEventPicks = readonly RawEntryEventPick[];
