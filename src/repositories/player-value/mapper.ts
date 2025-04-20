import { PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import {
  PlayerValueCreateInput,
  PrismaPlayerValueCreateInput,
} from 'src/repositories/player-value/type';
import { ElementType, ValueChangeType } from 'src/types/base.type';
import { PlayerValue } from 'src/types/domain/player-value.type';

export const mapPrismaPlayerValueToDomain = (
  prismaPlayerValue: PrismaPlayerValueType,
): PlayerValue => ({
  element: prismaPlayerValue.element,
  elementType: prismaPlayerValue.elementType as ElementType,
  event: prismaPlayerValue.event,
  value: prismaPlayerValue.value,
  changeDate: prismaPlayerValue.changeDate,
  changeType: prismaPlayerValue.changeType as ValueChangeType,
  lastValue: prismaPlayerValue.lastValue,
});

export const mapDomainPlayerValueToPrismaCreate = (
  domainPlayerValue: PlayerValueCreateInput,
): PrismaPlayerValueCreateInput => ({
  element: domainPlayerValue.element,
  elementType: domainPlayerValue.elementType as number,
  event: domainPlayerValue.event,
  value: domainPlayerValue.value,
  changeDate: domainPlayerValue.changeDate,
  changeType: domainPlayerValue.changeType as ValueChangeType,
  lastValue: domainPlayerValue.lastValue,
});
