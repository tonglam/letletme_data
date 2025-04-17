import { PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import {
  PrismaPlayerValueCreate,
  PrismaPlayerValueCreateInput,
} from 'src/repositories/player-value/type';
import { ElementType, ValueChangeType } from 'src/types/base.type';
import { MappedPlayerValue, PlayerValue, PlayerValueId } from 'src/types/domain/player-value.type';

export const mapPrismaPlayerValueToDomain = (
  prismaPlayerValue: PrismaPlayerValueType,
): PlayerValue => ({
  id: prismaPlayerValue.id.toString() as PlayerValueId,
  elementId: prismaPlayerValue.elementId,
  elementType: prismaPlayerValue.elementType as ElementType,
  eventId: prismaPlayerValue.eventId,
  value: prismaPlayerValue.value,
  changeDate: prismaPlayerValue.changeDate,
  changeType: prismaPlayerValue.changeType,
  lastValue: prismaPlayerValue.lastValue,
});

export const mapDomainPlayerValueToPrismaCreate = (
  domainPlayerValue: PrismaPlayerValueCreate,
): PrismaPlayerValueCreateInput => ({
  elementId: domainPlayerValue.elementId,
  elementType: domainPlayerValue.elementType as number,
  eventId: domainPlayerValue.eventId,
  value: domainPlayerValue.value,
  changeDate: domainPlayerValue.changeDate,
  changeType: domainPlayerValue.changeType,
  lastValue: domainPlayerValue.lastValue,
});

export const mapMappedPlayerValueToPrismaCreate = (
  mappedPlayerValue: MappedPlayerValue,
): PrismaPlayerValueCreate => ({
  elementId: mappedPlayerValue.elementId,
  elementType: mappedPlayerValue.elementType,
  eventId: mappedPlayerValue.eventId,
  value: mappedPlayerValue.value,
  changeDate: mappedPlayerValue.changeDate,
  changeType: ValueChangeType.Start,
  lastValue: 0,
});
