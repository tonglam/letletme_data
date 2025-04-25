import { PlayerValueTrack as PrismaPlayerValueTrackType } from '@prisma/client';
import {
  PrismaPlayerValueTrackCreateInput,
  PlayerValueTrackCreateInput,
} from 'src/repositories/player-value-track/types';
import { ElementTypeId } from 'src/types/base.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerValueTrack } from 'src/types/domain/player-value-track.type';
import { PlayerId } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';

export const mapPrismaPlayerValueTrackToDomain = (
  prismaPlayerValueTrack: PrismaPlayerValueTrackType,
): PlayerValueTrack => ({
  hourIndex: prismaPlayerValueTrack.hourIndex,
  date: prismaPlayerValueTrack.date,
  eventId: prismaPlayerValueTrack.eventId as EventId,
  elementId: prismaPlayerValueTrack.elementId as PlayerId,
  elementType: prismaPlayerValueTrack.elementType as ElementTypeId,
  teamId: prismaPlayerValueTrack.teamId as TeamId,
  chanceOfPlayingThisRound: prismaPlayerValueTrack.chanceOfPlayingThisRound ?? null,
  chanceOfPlayingNextRound: prismaPlayerValueTrack.chanceOfPlayingNextRound ?? null,
  transfersIn: prismaPlayerValueTrack.transfersIn,
  transfersOut: prismaPlayerValueTrack.transfersOut,
  transfersInEvent: prismaPlayerValueTrack.transfersInEvent,
  transfersOutEvent: prismaPlayerValueTrack.transfersOutEvent,
  selectedBy: prismaPlayerValueTrack.selectedBy ?? null,
  value: prismaPlayerValueTrack.value,
});

export const mapDomainPlayerValueTrackToPrismaCreate = (
  domainPlayerValueTrack: PlayerValueTrackCreateInput,
): PrismaPlayerValueTrackCreateInput => ({
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
