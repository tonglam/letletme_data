import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/db/prisma';
import { EventOperations } from './operations';
import { Event, EventResult } from './types';

type EventPrismaResult = {
  id: number;
  name: string;
  deadlineTime: Date;
  deadlineTimeEpoch: number;
  deadlineTimeGameOffset: number;
  releaseTime: Date | null;
  averageEntryScore: number;
  finished: boolean;
  dataChecked: boolean;
  highestScore: number;
  highestScoringEntry: number;
  isPrevious: boolean;
  isCurrent: boolean;
  isNext: boolean;
  cupLeaguesCreated: boolean;
  h2hKoMatchesCreated: boolean;
  rankedCount: number;
  chipPlays: Prisma.JsonValue;
  mostSelected: number | null;
  mostTransferredIn: number | null;
  mostCaptained: number | null;
  mostViceCaptained: number | null;
  topElement: number | null;
  topElementInfo: Prisma.JsonValue;
  transfersMade: number;
  createdAt: Date;
};

const mapEventFromPrisma = (event: EventPrismaResult): Event => {
  const baseEvent = {
    id: event.id,
    name: event.name,
    deadlineTime: event.deadlineTime.toISOString(),
    deadlineTimeEpoch: event.deadlineTimeEpoch,
    deadlineTimeGameOffset: event.deadlineTimeGameOffset,
    releaseTime: event.releaseTime?.toISOString() ?? null,
    averageEntryScore: event.averageEntryScore,
    highestScore: event.highestScore,
    highestScoringEntry: event.highestScoringEntry,
    isFinished: event.finished,
    dataChecked: event.dataChecked,
    isPrevious: event.isPrevious,
    isCurrent: event.isCurrent,
    isNext: event.isNext,
    cupLeaguesCreated: event.cupLeaguesCreated,
    h2hKoMatchesCreated: event.h2hKoMatchesCreated,
    rankedCount: event.rankedCount,
    chipPlays: (event.chipPlays as { chipName: string; numPlayed: number }[]) ?? [],
    mostSelected: event.mostSelected,
    mostTransferredIn: event.mostTransferredIn,
    mostCaptained: event.mostCaptained,
    mostViceCaptained: event.mostViceCaptained,
    topElement: event.topElement,
    topElementInfo: event.topElementInfo as { id: number; points: number } | null,
    transfersMade: event.transfersMade,
    createdAt: event.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'upcoming' as const,
  };

  return {
    ...baseEvent,
    status: EventOperations.getEventStatus(baseEvent),
  };
};

/**
 * Event repository operations
 */
export const EventRepository = {
  /**
   * Find event by ID
   */
  findById: async (id: number): Promise<EventResult<Event>> => {
    try {
      const event = await prisma.event.findUnique({
        where: { id },
      });

      if (!event) {
        return {
          success: false,
          error: `Event ${id} not found`,
        };
      }

      return {
        success: true,
        data: mapEventFromPrisma(event),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error finding event',
      };
    }
  },

  /**
   * Find current event
   */
  findCurrent: async (): Promise<EventResult<Event>> => {
    try {
      const event = await prisma.event.findFirst({
        where: {
          isCurrent: true,
        },
      });

      if (!event) {
        return {
          success: false,
          error: 'No current event found',
        };
      }

      return {
        success: true,
        data: mapEventFromPrisma(event),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error finding current event',
      };
    }
  },

  /**
   * Update event
   */
  update: async (id: number, event: Partial<Event>): Promise<EventResult<Event>> => {
    try {
      const existing = await prisma.event.findUnique({
        where: { id },
      });

      if (!existing) {
        return {
          success: false,
          error: `Event ${id} not found`,
        };
      }

      const updated = await prisma.event.update({
        where: { id },
        data: {
          name: event.name,
          deadlineTime: event.deadlineTime ? new Date(event.deadlineTime) : undefined,
          deadlineTimeEpoch: event.deadlineTimeEpoch,
          deadlineTimeGameOffset: event.deadlineTimeGameOffset,
          releaseTime: event.releaseTime ? new Date(event.releaseTime) : undefined,
          averageEntryScore: event.averageEntryScore,
          finished: event.isFinished,
          dataChecked: event.dataChecked,
          highestScore: event.highestScore,
          highestScoringEntry: event.highestScoringEntry,
          isPrevious: event.isPrevious,
          isCurrent: event.isCurrent,
          isNext: event.isNext,
          cupLeaguesCreated: event.cupLeaguesCreated,
          h2hKoMatchesCreated: event.h2hKoMatchesCreated,
          rankedCount: event.rankedCount,
          chipPlays: event.chipPlays
            ? (event.chipPlays as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          mostSelected: event.mostSelected,
          mostTransferredIn: event.mostTransferredIn,
          mostCaptained: event.mostCaptained,
          mostViceCaptained: event.mostViceCaptained,
          topElement: event.topElement,
          topElementInfo: event.topElementInfo
            ? (event.topElementInfo as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          transfersMade: event.transfersMade,
        },
      });

      return {
        success: true,
        data: mapEventFromPrisma(updated),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error updating event',
      };
    }
  },

  /**
   * Find all events
   */
  findAll: async (): Promise<EventResult<ReadonlyArray<Event>>> => {
    try {
      const events = await prisma.event.findMany({
        orderBy: {
          deadlineTimeEpoch: 'asc',
        },
      });

      return {
        success: true,
        data: events.map(mapEventFromPrisma),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error finding events',
      };
    }
  },
} as const;
