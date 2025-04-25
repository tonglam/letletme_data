import { RawEntryEventTransfer } from 'src/types/domain/entry-event-transfer.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';

import {
  EntryEventTransferCreateInput,
  PrismaEntryEventTransfer,
  PrismaEntryEventTransferCreateInput,
} from './types';

export const mapPrismaEntryEventTransferToDomain = (
  prismaEntryEventTransfer: PrismaEntryEventTransfer,
): RawEntryEventTransfer => ({
  entryId: prismaEntryEventTransfer.entryId as EntryId,
  eventId: prismaEntryEventTransfer.eventId as EventId,
  elementInId: prismaEntryEventTransfer.elementInId as PlayerId,
  elementInCost: prismaEntryEventTransfer.elementInCost as number,
  elementInPoints: prismaEntryEventTransfer.elementInPoints as number,
  elementOutId: prismaEntryEventTransfer.elementOutId as PlayerId,
  elementOutCost: prismaEntryEventTransfer.elementOutCost as number,
  elementOutPoints: prismaEntryEventTransfer.elementOutPoints as number,
  transferTime: prismaEntryEventTransfer.transferTime as Date,
});

export const mapDomainEntryEventTransferToPrismaCreate = (
  domainEntryEventTransfer: EntryEventTransferCreateInput,
): PrismaEntryEventTransferCreateInput => ({
  entryId: domainEntryEventTransfer.entryId,
  eventId: domainEntryEventTransfer.eventId,
  elementInId: domainEntryEventTransfer.elementInId,
  elementInCost: domainEntryEventTransfer.elementInCost,
  elementInPoints: domainEntryEventTransfer.elementInPoints,
  elementOutId: domainEntryEventTransfer.elementOutId,
  elementOutCost: domainEntryEventTransfer.elementOutCost,
  elementOutPoints: domainEntryEventTransfer.elementOutPoints,
  transferTime: domainEntryEventTransfer.transferTime,
});
