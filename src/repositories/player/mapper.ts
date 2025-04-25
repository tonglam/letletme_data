import { PlayerId, PlayerType, RawPlayer } from 'src/types/domain/player.type';
import { TeamId } from 'src/types/domain/team.type';

import { PrismaPlayer, PrismaPlayerCreateInput } from './types';

export const mapPrismaPlayerToDomain = (prismaPlayer: PrismaPlayer): RawPlayer => ({
  id: prismaPlayer.id as PlayerId,
  code: prismaPlayer.code,
  type: prismaPlayer.type as PlayerType,
  teamId: prismaPlayer.teamId as TeamId,
  price: prismaPlayer.price,
  startPrice: prismaPlayer.startPrice,
  firstName: prismaPlayer.firstName,
  secondName: prismaPlayer.secondName,
  webName: prismaPlayer.webName,
});

export const mapDomainPlayerToPrismaCreate = (
  domainPlayer: RawPlayer,
): PrismaPlayerCreateInput => ({
  id: domainPlayer.id,
  code: domainPlayer.code,
  type: domainPlayer.type,
  teamId: domainPlayer.teamId,
  price: domainPlayer.price,
  startPrice: domainPlayer.startPrice,
  firstName: domainPlayer.firstName,
  secondName: domainPlayer.secondName,
  webName: domainPlayer.webName,
});
