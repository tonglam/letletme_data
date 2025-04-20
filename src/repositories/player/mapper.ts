import { Player, PlayerId } from 'src/types/domain/player.type';

import { PrismaPlayer, PrismaPlayerCreateInput } from './type';

export const mapPrismaPlayerToDomain = (prismaPlayer: PrismaPlayer): Player => ({
  element: prismaPlayer.element as PlayerId,
  code: prismaPlayer.code,
  elementType: prismaPlayer.elementType,
  team: prismaPlayer.team,
  price: prismaPlayer.price,
  startPrice: prismaPlayer.startPrice,
  firstName: prismaPlayer.firstName,
  secondName: prismaPlayer.secondName,
  webName: prismaPlayer.webName,
});

export const mapDomainPlayerToPrismaCreate = (domainPlayer: Player): PrismaPlayerCreateInput => ({
  element: domainPlayer.element,
  code: domainPlayer.code,
  elementType: domainPlayer.elementType,
  team: domainPlayer.team,
  price: domainPlayer.price,
  startPrice: domainPlayer.startPrice,
  firstName: domainPlayer.firstName,
  secondName: domainPlayer.secondName,
  webName: domainPlayer.webName,
});
