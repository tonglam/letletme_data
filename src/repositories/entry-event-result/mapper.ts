import { $Enums as PrismaEnums } from '@prisma/client';
import { Chip } from 'src/types/base.type';
import { PickItem } from 'src/types/domain/entry-event-pick.type';
import { RawEntryEventResult } from 'src/types/domain/entry-event-result.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';

import {
  EntryEventResultCreateInput,
  PrismaEntryEventResult,
  PrismaEntryEventResultCreateInput,
} from './types';

export const mapPrismaEntryEventResultToDomain = (
  prismaEntryEventResult: PrismaEntryEventResult,
): RawEntryEventResult => ({
  entryId: prismaEntryEventResult.entryId as EntryId,
  eventId: prismaEntryEventResult.eventId as EventId,
  eventPoints: prismaEntryEventResult.eventPoints as number,
  eventTransfers: prismaEntryEventResult.eventTransfers as number,
  eventTransfersCost: prismaEntryEventResult.eventTransfersCost as number,
  eventNetPoints: prismaEntryEventResult.eventNetPoints as number,
  eventBenchPoints: prismaEntryEventResult.eventBenchPoints as number,
  eventAutoSubPoints: prismaEntryEventResult.eventAutoSubPoints as number,
  eventRank: prismaEntryEventResult.eventRank as number,
  eventChip: prismaEntryEventResult.eventChip as Chip,
  eventPlayedCaptain: prismaEntryEventResult.eventPlayedCaptain as PlayerId,
  eventCaptainPoints: prismaEntryEventResult.eventCaptainPoints as number,
  eventPicks: prismaEntryEventResult.eventPicks as PickItem[],
  eventAutoSub: prismaEntryEventResult.eventAutoSub as PickItem[],
  overallPoints: prismaEntryEventResult.overallPoints as number,
  overallRank: prismaEntryEventResult.overallRank as number,
  teamValue: prismaEntryEventResult.teamValue as number,
  bank: prismaEntryEventResult.bank as number,
});

export const mapDomainEntryEventResultToPrismaCreate = (
  domainEntryEventResult: EntryEventResultCreateInput,
): PrismaEntryEventResultCreateInput => ({
  entryId: domainEntryEventResult.entryId,
  eventId: domainEntryEventResult.eventId,
  eventPoints: domainEntryEventResult.eventPoints,
  eventTransfers: domainEntryEventResult.eventTransfers,
  eventTransfersCost: domainEntryEventResult.eventTransfersCost,
  eventNetPoints: domainEntryEventResult.eventNetPoints,
  eventBenchPoints: domainEntryEventResult.eventBenchPoints,
  eventAutoSubPoints: domainEntryEventResult.eventAutoSubPoints,
  eventRank: domainEntryEventResult.eventRank,
  eventChip:
    domainEntryEventResult.eventChip === null || domainEntryEventResult.eventChip === Chip.None
      ? PrismaEnums.Chip.None
      : (domainEntryEventResult.eventChip as unknown as PrismaEnums.Chip),
  eventPlayedCaptain: domainEntryEventResult.eventPlayedCaptain,
  eventCaptainPoints: domainEntryEventResult.eventCaptainPoints,
  eventPicks: domainEntryEventResult.eventPicks,
  eventAutoSub: domainEntryEventResult.eventAutoSub,
  overallPoints: domainEntryEventResult.overallPoints,
  overallRank: domainEntryEventResult.overallRank,
  teamValue: domainEntryEventResult.teamValue,
  bank: domainEntryEventResult.bank,
});
