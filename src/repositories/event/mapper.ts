import { Prisma } from '@prisma/client';
import { ChipPlay, Event, EventId, TopElementInfo } from 'src/types/domain/event.type';

import { PrismaEvent, PrismaEventCreate, PrismaEventCreateInput } from './type';

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
  deadlineTime: prismaEvent.deadlineTime,
  finished: prismaEvent.finished,
  isPrevious: prismaEvent.isPrevious,
  isCurrent: prismaEvent.isCurrent,
  isNext: prismaEvent.isNext,
  deadlineTimeEpoch: prismaEvent.deadlineTimeEpoch,
  deadlineTimeGameOffset: prismaEvent.deadlineTimeGameOffset,
  averageEntryScore: prismaEvent.averageEntryScore,
  dataChecked: prismaEvent.dataChecked,
  highestScore: prismaEvent.highestScore,
  highestScoringEntry: prismaEvent.highestScoringEntry,
  cupLeaguesCreated: prismaEvent.cupLeaguesCreated,
  h2hKoMatchesCreated: prismaEvent.h2hKoMatchesCreated,
  transfersMade: prismaEvent.transfersMade,
  releaseTime: prismaEvent.releaseTime,
  rankedCount: prismaEvent.rankedCount,
  chipPlays: parseChipPlays(prismaEvent.chipPlays),
  mostSelected: prismaEvent.mostSelected,
  mostTransferredIn: prismaEvent.mostTransferredIn,
  mostCaptained: prismaEvent.mostCaptained,
  mostViceCaptained: prismaEvent.mostViceCaptained,
  topElement: prismaEvent.topElement,
  topElementInfo: parseTopElementInfo(prismaEvent.topElementInfo),
});

export const mapDomainEventToPrismaCreate = (
  domainEvent: PrismaEventCreate,
): PrismaEventCreateInput => ({
  id: Number(domainEvent.id),
  name: domainEvent.name,
  deadlineTime: domainEvent.deadlineTime,
  deadlineTimeEpoch: domainEvent.deadlineTimeEpoch,
  finished: domainEvent.finished,
  isPrevious: domainEvent.isPrevious,
  isCurrent: domainEvent.isCurrent,
  isNext: domainEvent.isNext,
  averageEntryScore: domainEvent.averageEntryScore,
  dataChecked: domainEvent.dataChecked,
  highestScore: domainEvent.highestScore ?? undefined,
  highestScoringEntry: domainEvent.highestScoringEntry ?? undefined,
  cupLeaguesCreated: domainEvent.cupLeaguesCreated,
  h2hKoMatchesCreated: domainEvent.h2hKoMatchesCreated,
  transfersMade: domainEvent.transfersMade,
  deadlineTimeGameOffset: domainEvent.deadlineTimeGameOffset,
  releaseTime: domainEvent.releaseTime ?? null,
});
