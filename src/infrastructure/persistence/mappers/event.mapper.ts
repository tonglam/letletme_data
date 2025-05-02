import { DbEvent, DbEventInsert, EventCreateInput } from 'repository/event/types';
import { ChipPlay, Event, EventId, TopElementInfo } from 'types/domain/event.type';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChipPlays(data: unknown): readonly ChipPlay[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const validPlays: ChipPlay[] = [];
  for (const item of data) {
    if (
      isObject(item) &&
      typeof item.chip_name === 'string' &&
      typeof item.num_played === 'number'
    ) {
      validPlays.push({ chip_name: item.chip_name, num_played: item.num_played });
    }
  }
  return validPlays;
}

function parseTopElementInfo(data: unknown): TopElementInfo | null {
  if (isObject(data) && typeof data.id === 'number' && typeof data.points === 'number') {
    return { id: data.id, points: data.points };
  }
  return null;
}

export const mapDbEventToDomain = (dbEvent: DbEvent): Event => ({
  id: dbEvent.id as EventId,
  name: dbEvent.name,
  deadlineTime: dbEvent.deadlineTime.toISOString(),
  averageEntryScore: dbEvent.averageEntryScore,
  finished: dbEvent.finished,
  dataChecked: dbEvent.dataChecked,
  highestScore: dbEvent.highestScore,
  highestScoringEntry: dbEvent.highestScoringEntry,
  isPrevious: dbEvent.isPrevious,
  isCurrent: dbEvent.isCurrent,
  isNext: dbEvent.isNext,
  cupLeaguesCreated: dbEvent.cupLeaguesCreated,
  h2hKoMatchesCreated: dbEvent.h2hKoMatchesCreated,
  rankedCount: dbEvent.rankedCount,
  chipPlays: parseChipPlays(dbEvent.chipPlays),
  mostSelected: dbEvent.mostSelected,
  mostTransferredIn: dbEvent.mostTransferredIn,
  mostCaptained: dbEvent.mostCaptained,
  mostViceCaptained: dbEvent.mostViceCaptained,
  topElement: dbEvent.topElement,
  topElementInfo: parseTopElementInfo(dbEvent.topElementInfo),
  transfersMade: dbEvent.transfersMade,
});

export const mapDomainEventToDbCreate = (domainEvent: EventCreateInput): DbEventInsert => {
  const chipPlaysInput =
    domainEvent.chipPlays && domainEvent.chipPlays.length > 0 ? domainEvent.chipPlays : null;
  const topElementInfoInput = domainEvent.topElementInfo ? domainEvent.topElementInfo : null;

  return {
    id: Number(domainEvent.id),
    name: domainEvent.name,
    deadlineTime: new Date(domainEvent.deadlineTime),
    averageEntryScore: domainEvent.averageEntryScore,
    finished: domainEvent.finished,
    dataChecked: domainEvent.dataChecked,
    highestScore: domainEvent.highestScore ?? undefined,
    highestScoringEntry: domainEvent.highestScoringEntry ?? undefined,
    isPrevious: domainEvent.isPrevious,
    isCurrent: domainEvent.isCurrent,
    isNext: domainEvent.isNext,
    cupLeaguesCreated: domainEvent.cupLeaguesCreated,
    h2hKoMatchesCreated: domainEvent.h2hKoMatchesCreated,
    rankedCount: domainEvent.rankedCount,
    chipPlays: chipPlaysInput,
    mostSelected: domainEvent.mostSelected ?? undefined,
    mostTransferredIn: domainEvent.mostTransferredIn ?? undefined,
    mostCaptained: domainEvent.mostCaptained ?? undefined,
    mostViceCaptained: domainEvent.mostViceCaptained ?? undefined,
    topElement: domainEvent.topElement ?? undefined,
    topElementInfo: topElementInfoInput,
    transfersMade: domainEvent.transfersMade,
  };
};
