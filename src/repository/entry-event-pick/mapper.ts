import { Chip } from 'types/base.type';
import { PickItem, RawEntryEventPick } from 'types/domain/entry-event-pick.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EventId } from 'types/domain/event.type';

import { EntryEventPickCreateInput, DbEntryEventPick, DbEntryEventPickCreateInput } from './types';

export const mapDbEntryEventPickToDomain = (
  dbEntryEventPick: DbEntryEventPick,
): RawEntryEventPick => ({
  entryId: dbEntryEventPick.entryId as EntryId,
  eventId: dbEntryEventPick.eventId as EventId,
  chip: dbEntryEventPick.chip as Chip,
  picks: dbEntryEventPick.picks as PickItem[],
  transfers: dbEntryEventPick.transfers as number,
  transfersCost: dbEntryEventPick.transfersCost as number,
});

export const mapDomainEntryEventPickToDbCreate = (
  domainEntryEventPick: EntryEventPickCreateInput,
): DbEntryEventPickCreateInput => ({
  entryId: domainEntryEventPick.entryId,
  eventId: domainEntryEventPick.eventId,
  chip: (domainEntryEventPick.chip === null || domainEntryEventPick.chip === 'n/a'
    ? 'n/a'
    : domainEntryEventPick.chip) as DbEntryEventPickCreateInput['chip'],
  picks: domainEntryEventPick.picks,
  transfers: domainEntryEventPick.transfers,
  transfersCost: domainEntryEventPick.transfersCost,
});
