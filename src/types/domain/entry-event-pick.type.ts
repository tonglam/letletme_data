import { Chip, ElementTypeId, ElementTypeName } from 'src/types/base.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';

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
  'webName' | 'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName' | 'value'
>;
export type RawEntryEventPick = Omit<EntryEventPick, 'entryName'>;
export type RawEntryEventPicks = readonly RawEntryEventPick[];
