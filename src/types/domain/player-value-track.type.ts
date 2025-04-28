import { ElementTypeId } from 'types/base.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

export interface PlayerValueTrack {
  readonly hourIndex: number;
  readonly date: string;
  readonly eventId: EventId;
  readonly elementId: PlayerId;
  readonly elementType: ElementTypeId;
  readonly teamId: TeamId;
  readonly chanceOfPlayingThisRound: number | null;
  readonly chanceOfPlayingNextRound: number | null;
  readonly transfersIn: number;
  readonly transfersOut: number;
  readonly transfersInEvent: number;
  readonly transfersOutEvent: number;
  readonly selectedBy: number | null;
  readonly value: number;
}
export type PlayerValueTracks = readonly PlayerValueTrack[];
