import {
  EntryEventResultCreateInput,
  DbEntryEventResult,
  DbEntryEventResultCreateInput,
} from 'repository/entry-event-result/types';
import { Chip } from 'types/base.type';
import { PickItem } from 'types/domain/entry-event-pick.type';
import { RawEntryEventResult } from 'types/domain/entry-event-result.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';

export const mapDbEntryEventResultToDomain = (
  dbEntryEventResult: DbEntryEventResult,
): RawEntryEventResult => ({
  entryId: dbEntryEventResult.entryId as EntryId,
  eventId: dbEntryEventResult.eventId as EventId,
  eventPoints: dbEntryEventResult.eventPoints as number,
  eventTransfers: dbEntryEventResult.eventTransfers as number,
  eventTransfersCost: dbEntryEventResult.eventTransfersCost as number,
  eventNetPoints: dbEntryEventResult.eventNetPoints as number,
  eventBenchPoints: dbEntryEventResult.eventBenchPoints as number,
  eventAutoSubPoints: dbEntryEventResult.eventAutoSubPoints as number,
  eventRank: dbEntryEventResult.eventRank as number,
  eventChip: dbEntryEventResult.eventChip as Chip,
  eventPlayedCaptain: dbEntryEventResult.eventPlayedCaptain as PlayerId,
  eventCaptainPoints: dbEntryEventResult.eventCaptainPoints as number,
  eventPicks: dbEntryEventResult.eventPicks as PickItem[],
  eventAutoSub: dbEntryEventResult.eventAutoSub as PickItem[],
  overallPoints: dbEntryEventResult.overallPoints as number,
  overallRank: dbEntryEventResult.overallRank as number,
  teamValue: dbEntryEventResult.teamValue as number,
  bank: dbEntryEventResult.bank as number,
});

export const mapDomainEntryEventResultToDbCreate = (
  domainEntryEventResult: EntryEventResultCreateInput,
): DbEntryEventResultCreateInput => ({
  entryId: domainEntryEventResult.entryId,
  eventId: domainEntryEventResult.eventId,
  eventPoints: domainEntryEventResult.eventPoints,
  eventTransfers: domainEntryEventResult.eventTransfers,
  eventTransfersCost: domainEntryEventResult.eventTransfersCost,
  eventNetPoints: domainEntryEventResult.eventNetPoints,
  eventBenchPoints: domainEntryEventResult.eventBenchPoints,
  eventAutoSubPoints: domainEntryEventResult.eventAutoSubPoints,
  eventRank: domainEntryEventResult.eventRank,
  eventChip: (domainEntryEventResult.eventChip === null ||
  domainEntryEventResult.eventChip === Chip.None
    ? Chip.None
    : domainEntryEventResult.eventChip) as DbEntryEventResultCreateInput['eventChip'],
  eventPlayedCaptain: domainEntryEventResult.eventPlayedCaptain,
  eventCaptainPoints: domainEntryEventResult.eventCaptainPoints,
  eventPicks: domainEntryEventResult.eventPicks,
  eventAutoSub: domainEntryEventResult.eventAutoSub,
  overallPoints: domainEntryEventResult.overallPoints,
  overallRank: domainEntryEventResult.overallRank,
  teamValue: domainEntryEventResult.teamValue,
  bank: domainEntryEventResult.bank,
});
