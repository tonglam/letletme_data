import {
  PlayerValueTrackCreateInput,
  DbPlayerValueTrack,
  DbPlayerValueTrackCreateInput,
} from 'repository/player-value-track/types';
import { ElementTypeId } from 'types/base.type';
import { EventId } from 'types/domain/event.type';
import { PlayerValueTrack } from 'types/domain/player-value-track.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';

export const mapDbPlayerValueTrackToDomain = (
  dbPlayerValueTrack: DbPlayerValueTrack,
): PlayerValueTrack => ({
  hourIndex: dbPlayerValueTrack.hourIndex,
  date: dbPlayerValueTrack.date,
  eventId: dbPlayerValueTrack.eventId as EventId,
  elementId: dbPlayerValueTrack.elementId as PlayerId,
  elementType: dbPlayerValueTrack.elementType as ElementTypeId,
  teamId: dbPlayerValueTrack.teamId as TeamId,
  chanceOfPlayingThisRound: dbPlayerValueTrack.chanceOfPlayingThisRound ?? null,
  chanceOfPlayingNextRound: dbPlayerValueTrack.chanceOfPlayingNextRound ?? null,
  transfersIn: dbPlayerValueTrack.transfersIn,
  transfersOut: dbPlayerValueTrack.transfersOut,
  transfersInEvent: dbPlayerValueTrack.transfersInEvent,
  transfersOutEvent: dbPlayerValueTrack.transfersOutEvent,
  selectedBy: dbPlayerValueTrack.selectedBy ?? null,
  value: dbPlayerValueTrack.value,
});

export const mapDomainPlayerValueTrackToDbCreate = (
  domainPlayerValueTrack: PlayerValueTrackCreateInput,
): DbPlayerValueTrackCreateInput => ({
  hourIndex: domainPlayerValueTrack.hourIndex,
  date: domainPlayerValueTrack.date,
  eventId: domainPlayerValueTrack.eventId,
  elementId: domainPlayerValueTrack.elementId,
  elementType: domainPlayerValueTrack.elementType,
  teamId: domainPlayerValueTrack.teamId,
  chanceOfPlayingThisRound: domainPlayerValueTrack.chanceOfPlayingThisRound,
  chanceOfPlayingNextRound: domainPlayerValueTrack.chanceOfPlayingNextRound,
  transfersIn: domainPlayerValueTrack.transfersIn,
  transfersOut: domainPlayerValueTrack.transfersOut,
  transfersInEvent: domainPlayerValueTrack.transfersInEvent,
  transfersOutEvent: domainPlayerValueTrack.transfersOutEvent,
  selectedBy: domainPlayerValueTrack.selectedBy ?? 0,
  value: domainPlayerValueTrack.value,
});
