import {
  EntryEventTransferCreateInput,
  DbEntryEventTransfer,
  DbEntryEventTransferCreateInput,
} from 'repository/entry-event-transfer/types';
import { RawEntryEventTransfer } from 'types/domain/entry-event-transfer.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';

export const mapDbEntryEventTransferToDomain = (
  dbEntryEventTransfer: DbEntryEventTransfer,
): RawEntryEventTransfer => ({
  entryId: dbEntryEventTransfer.entryId as EntryId,
  eventId: dbEntryEventTransfer.eventId as EventId,
  elementInId: dbEntryEventTransfer.elementInId as PlayerId,
  elementInCost: dbEntryEventTransfer.elementInCost as number,
  elementOutId: dbEntryEventTransfer.elementOutId as PlayerId,
  elementOutCost: dbEntryEventTransfer.elementOutCost as number,
  transferTime: dbEntryEventTransfer.transferTime as Date,
});

export const mapDomainEntryEventTransferToDbCreate = (
  domainEntryEventTransfer: EntryEventTransferCreateInput,
): DbEntryEventTransferCreateInput => ({
  entryId: domainEntryEventTransfer.entryId,
  eventId: domainEntryEventTransfer.eventId,
  elementInId: domainEntryEventTransfer.elementInId,
  elementInCost: domainEntryEventTransfer.elementInCost,
  elementOutId: domainEntryEventTransfer.elementOutId,
  elementOutCost: domainEntryEventTransfer.elementOutCost,
  transferTime: domainEntryEventTransfer.transferTime,
});
