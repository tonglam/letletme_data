import { ElementTypeId, ElementTypeName } from 'src/types/base.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';

export type EntryEventTransfer = {
  readonly entryId: EntryId;
  readonly entryName: string;
  readonly eventId: EventId;
  readonly elementInId: PlayerId;
  readonly elementInWebName: string;
  readonly elementInType: ElementTypeId;
  readonly elementInTypeName: ElementTypeName;
  readonly elementInTeamId: TeamId;
  readonly elementInTeamName: string;
  readonly elementInTeamShortName: string;
  readonly elementInCost: number;
  readonly elementInPoints: number;
  readonly elementOutId: PlayerId;
  readonly elementOutWebName: string;
  readonly elementOutType: ElementTypeId;
  readonly elementOutTypeName: ElementTypeName;
  readonly elementOutTeamId: TeamId;
  readonly elementOutTeamName: string;
  readonly elementOutTeamShortName: string;
  readonly elementOutCost: number;
  readonly elementOutPoints: number;
  readonly transferTime: Date;
};

export type EntryEventTransfers = readonly EntryEventTransfer[];

export type RawEntryEventTransfer = Omit<
  EntryEventTransfer,
  | 'entryName'
  | 'elementInWebName'
  | 'elementInType'
  | 'elementInTypeName'
  | 'elementInTeamId'
  | 'elementInTeamName'
  | 'elementInTeamShortName'
  | 'elementInPoints'
  | 'elementOutWebName'
  | 'elementOutType'
  | 'elementOutTypeName'
  | 'elementOutTeamId'
  | 'elementOutTeamName'
  | 'elementOutTeamShortName'
  | 'elementOutPoints'
>;
export type RawEntryEventTransfers = readonly RawEntryEventTransfer[];
