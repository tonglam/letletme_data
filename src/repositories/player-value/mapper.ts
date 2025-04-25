import { PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import {
  PlayerValueCreateInput,
  PrismaPlayerValueCreateInput,
} from 'src/repositories/player-value/types';
import { ElementTypeId, ValueChangeType } from 'src/types/base.type';
import { EventId } from 'src/types/domain/event.type';
import { RawPlayerValue } from 'src/types/domain/player-value.type';
import { PlayerId } from 'src/types/domain/player.type';

export const mapPrismaPlayerValueToDomain = (
  prismaPlayerValue: PrismaPlayerValueType,
): RawPlayerValue => ({
  elementId: prismaPlayerValue.elementId as PlayerId,
  elementType: prismaPlayerValue.elementType as ElementTypeId,
  eventId: prismaPlayerValue.eventId as EventId,
  value: prismaPlayerValue.value,
  changeDate: prismaPlayerValue.changeDate,
  changeType: prismaPlayerValue.changeType as ValueChangeType,
  lastValue: prismaPlayerValue.lastValue,
});

export const mapDomainPlayerValueToPrismaCreate = (
  domainPlayerValue: PlayerValueCreateInput,
): PrismaPlayerValueCreateInput => ({
  elementId: domainPlayerValue.elementId,
  elementType: domainPlayerValue.elementType,
  eventId: domainPlayerValue.eventId,
  value: domainPlayerValue.value,
  changeDate: domainPlayerValue.changeDate,
  changeType: domainPlayerValue.changeType,
  lastValue: domainPlayerValue.lastValue,
});
