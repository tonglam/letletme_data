import { PlayerValueTrack as PrismaPlayerValueTrackType } from '@prisma/client';
import {
  PrismaPlayerValueTrackCreateInput,
  PlayerValueTrackCreateInput,
} from 'src/repositories/player-value-track/type';
import { ElementTypeId } from 'src/types/base.type';
import { PlayerValueTrack } from 'src/types/domain/player-value-track.type';
import { TeamId } from 'src/types/domain/team.type';

export const mapPrismaPlayerValueTrackToDomain = (
  prismaPlayerValueTrack: PrismaPlayerValueTrackType,
): PlayerValueTrack => ({
  hourIndex: prismaPlayerValueTrack.hourIndex,
  date: prismaPlayerValueTrack.date,
  event: prismaPlayerValueTrack.event,
  element: prismaPlayerValueTrack.element,
  elementType: prismaPlayerValueTrack.elementType as ElementTypeId,
  team: prismaPlayerValueTrack.team as TeamId,
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
  event: domainPlayerValueTrack.event,
  element: domainPlayerValueTrack.element,
  elementType: domainPlayerValueTrack.elementType as number,
  team: domainPlayerValueTrack.team,
  chanceOfPlayingThisRound: domainPlayerValueTrack.chanceOfPlayingThisRound,
  chanceOfPlayingNextRound: domainPlayerValueTrack.chanceOfPlayingNextRound,
  transfersIn: domainPlayerValueTrack.transfersIn,
  transfersOut: domainPlayerValueTrack.transfersOut,
  transfersInEvent: domainPlayerValueTrack.transfersInEvent,
  transfersOutEvent: domainPlayerValueTrack.transfersOutEvent,
  selectedBy: domainPlayerValueTrack.selectedBy ?? 0,
  value: domainPlayerValueTrack.value,
});
