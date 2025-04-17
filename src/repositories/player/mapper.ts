import { ElementType } from 'src/types/base.type';
import { Player, PlayerId } from 'src/types/domain/player.type';

import { PrismaPlayer, PrismaPlayerCreate, PrismaPlayerCreateInput } from './type';

export const mapPrismaPlayerToDomain = (prismaPlayer: PrismaPlayer): Player => ({
  id: prismaPlayer.element as PlayerId,
  elementCode: prismaPlayer.elementCode,
  price: prismaPlayer.price / 10,
  startPrice: prismaPlayer.startPrice / 10,
  elementType: prismaPlayer.elementType as ElementType,
  firstName: prismaPlayer.firstName ?? null,
  secondName: prismaPlayer.secondName ?? null,
  webName: prismaPlayer.webName,
  teamId: prismaPlayer.teamId,
});

export const mapDomainPlayerToPrismaCreate = (
  domainPlayer: PrismaPlayerCreate,
): PrismaPlayerCreateInput => ({
  element: domainPlayer.id as number,
  elementCode: domainPlayer.elementCode,
  price: Math.round(domainPlayer.price * 10),
  startPrice: Math.round(domainPlayer.startPrice * 10),
  elementType: domainPlayer.elementType as number,
  firstName: domainPlayer.firstName,
  secondName: domainPlayer.secondName,
  webName: domainPlayer.webName,
  teamId: domainPlayer.teamId,
});
