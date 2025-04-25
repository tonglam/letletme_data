import { $Enums as PrismaEnums } from '@prisma/client';
import { Chip } from 'src/types/base.type';
import { PickItem, RawEntryEventPick } from 'src/types/domain/entry-event-pick.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';

import {
  EntryEventPickCreateInput,
  PrismaEntryEventPick,
  PrismaEntryEventPickCreateInput,
} from './types';

export const mapPrismaEntryEventPickToDomain = (
  prismaEntryEventPick: PrismaEntryEventPick,
): RawEntryEventPick => ({
  entryId: prismaEntryEventPick.entryId as EntryId,
  eventId: prismaEntryEventPick.eventId as EventId,
  chip: prismaEntryEventPick.chip as Chip,
  picks: prismaEntryEventPick.picks as PickItem[],
  transfers: prismaEntryEventPick.transfers as number,
  transfersCost: prismaEntryEventPick.transfersCost as number,
});

export const mapDomainEntryEventPickToPrismaCreate = (
  domainEntryEventPick: EntryEventPickCreateInput,
): PrismaEntryEventPickCreateInput => ({
  entryId: domainEntryEventPick.entryId,
  eventId: domainEntryEventPick.eventId,
  chip:
    domainEntryEventPick.chip === null || domainEntryEventPick.chip === Chip.None
      ? PrismaEnums.Chip.None
      : (domainEntryEventPick.chip as unknown as PrismaEnums.Chip),
  picks: domainEntryEventPick.picks,
  transfers: domainEntryEventPick.transfers,
  transfersCost: domainEntryEventPick.transfersCost,
});
