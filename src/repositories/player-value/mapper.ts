import {
  PrismaPlayerValue,
  PrismaPlayerValueCreate,
  PrismaPlayerValueCreateInput,
} from 'src/repositories/player-value/type';
import { PlayerValue, PlayerValueId } from 'src/types/domain/player-value.type';

export const mapPrismaPlayerValueToDomain = (
  prismaPlayerValue: PrismaPlayerValue,
): PlayerValue => ({
  id: prismaPlayerValue.id as PlayerValueId,
  elementId: prismaPlayerValue.elementId,
  elementType: prismaPlayerValue.elementType,
  eventId: prismaPlayerValue.eventId,
  value: prismaPlayerValue.value,
  changeDate: prismaPlayerValue.changeDate,
  changeType: prismaPlayerValue.changeType,
  lastValue: prismaPlayerValue.lastValue,
});

export const mapDomainPlayerValueToPrismaCreate = (
  domainPlayerValue: PrismaPlayerValueCreate,
): PrismaPlayerValueCreateInput => ({
  id: domainPlayerValue.id as string,
  elementId: domainPlayerValue.elementId,
  elementType: domainPlayerValue.elementType,
  eventId: domainPlayerValue.eventId,
  value: domainPlayerValue.value,
  changeDate: domainPlayerValue.changeDate,
  changeType: domainPlayerValue.changeType,
  lastValue: domainPlayerValue.lastValue,
});
