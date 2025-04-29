import {
  DbPlayerValue,
  DbPlayerValueCreateInput,
  PlayerValueCreateInput,
} from 'repository/player-value/types';
import { ElementTypeId, ValueChangeType } from 'types/base.type';
import { EventId } from 'types/domain/event.type';
import { RawPlayerValue } from 'types/domain/player-value.type';
import { PlayerId } from 'types/domain/player.type';

export const mapDbPlayerValueToDomain = (dbPlayerValue: DbPlayerValue): RawPlayerValue => ({
  elementId: dbPlayerValue.elementId as PlayerId,
  elementType: dbPlayerValue.elementType as ElementTypeId,
  eventId: dbPlayerValue.eventId as EventId,
  value: dbPlayerValue.value,
  changeDate: dbPlayerValue.changeDate,
  changeType: dbPlayerValue.changeType as ValueChangeType,
  lastValue: dbPlayerValue.lastValue,
});

export const mapDomainPlayerValueToPrismaCreate = (
  domainPlayerValue: PlayerValueCreateInput,
): DbPlayerValueCreateInput => {
  return {
    elementId: domainPlayerValue.elementId,
    elementType: domainPlayerValue.elementType,
    eventId: domainPlayerValue.eventId,
    value: domainPlayerValue.value,
    changeDate: domainPlayerValue.changeDate.replace(/-/g, ''),
    changeType: domainPlayerValue.changeType as unknown as DbPlayerValueCreateInput['changeType'],
    lastValue: domainPlayerValue.lastValue,
  };
};
