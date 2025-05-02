import { Chip } from 'types/base.type';
import { PickItem } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';

export type EntryEventResult = {
  readonly entryId: EntryId;
  readonly entryName: string;
  readonly playerName: string;
  readonly eventId: EventId;
  readonly eventPoints: number;
  readonly eventTransfers: number;
  readonly eventTransfersCost: number;
  readonly eventNetPoints: number;
  readonly eventBenchPoints: number;
  readonly eventAutoSubPoints: number;
  readonly eventRank: number;
  readonly eventChip: Chip;
  readonly eventPlayedCaptain: PlayerId;
  readonly eventCaptainPoints: number;
  readonly eventPicks: readonly PickItem[];
  readonly eventAutoSub: readonly PickItem[];
  readonly overallPoints: number;
  readonly overallRank: number;
  readonly teamValue: number;
  readonly bank: number;
};

export type EntryEventResults = readonly EntryEventResult[];

export type RawEntryEventResult = Omit<EntryEventResult, 'entryName' | 'playerName'>;
export type RawEntryEventResults = readonly RawEntryEventResult[];
