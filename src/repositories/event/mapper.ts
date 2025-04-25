import { Prisma } from '@prisma/client';
import { ChipPlay, Event, EventId, TopElementInfo } from 'src/types/domain/event.type';

import { EventCreateInput, PrismaEvent, PrismaEventCreateInput } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseChipPlays(data: Prisma.JsonValue): readonly ChipPlay[] {
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

function parseTopElementInfo(data: Prisma.JsonValue): TopElementInfo | null {
  if (isObject(data) && typeof data.id === 'number' && typeof data.points === 'number') {
    return { id: data.id, points: data.points };
  }
  return null;
}

export const mapPrismaEventToDomain = (prismaEvent: PrismaEvent): Event => ({
  id: prismaEvent.id as EventId,
  name: prismaEvent.name,
  deadlineTime: prismaEvent.deadlineTime.toISOString(),
  averageEntryScore: prismaEvent.averageEntryScore,
  finished: prismaEvent.finished,
  dataChecked: prismaEvent.dataChecked,
  highestScore: prismaEvent.highestScore,
  highestScoringEntry: prismaEvent.highestScoringEntry,
  isPrevious: prismaEvent.isPrevious,
  isCurrent: prismaEvent.isCurrent,
  isNext: prismaEvent.isNext,
  cupLeaguesCreated: prismaEvent.cupLeaguesCreated,
  h2hKoMatchesCreated: prismaEvent.h2hKoMatchesCreated,
  rankedCount: prismaEvent.rankedCount,
  chipPlays: parseChipPlays(prismaEvent.chipPlays),
  mostSelected: prismaEvent.mostSelected,
  mostTransferredIn: prismaEvent.mostTransferredIn,
  mostCaptained: prismaEvent.mostCaptained,
  mostViceCaptained: prismaEvent.mostViceCaptained,
  topElement: prismaEvent.topElement,
  topElementInfo: parseTopElementInfo(prismaEvent.topElementInfo),
  transfersMade: prismaEvent.transfersMade,
});

export const mapDomainEventToPrismaCreate = (
  domainEvent: EventCreateInput,
): PrismaEventCreateInput => {
  const chipPlaysInput =
    domainEvent.chipPlays && domainEvent.chipPlays.length > 0
      ? (domainEvent.chipPlays as unknown as Prisma.InputJsonValue)
      : Prisma.JsonNull;

  const topElementInfoInput = domainEvent.topElementInfo
    ? (domainEvent.topElementInfo as unknown as Prisma.InputJsonValue)
    : Prisma.JsonNull;

  return {
    id: Number(domainEvent.id),
    name: domainEvent.name,
    deadlineTime: domainEvent.deadlineTime,
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
    mostSelected: domainEvent.mostSelected ?? null,
    mostTransferredIn: domainEvent.mostTransferredIn ?? null,
    mostCaptained: domainEvent.mostCaptained ?? null,
    mostViceCaptained: domainEvent.mostViceCaptained ?? null,
    topElement: domainEvent.topElement ?? null,
    topElementInfo: topElementInfoInput,
    transfersMade: domainEvent.transfersMade,
  };
};
