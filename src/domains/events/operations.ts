import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { fromCompare } from 'fp-ts/Ord';
import { TimeOperations } from '../../shared/time/operations';
import { EventStatus, FixtureStatus } from '../base/types';
import { Event, EventFixture, EventLive, EventPlayerStats, EventResult } from './types';

/**
 * Event domain operations
 */
export const EventOperations = {
  /**
   * Calculate event average points
   */
  calculateAveragePoints: (points: ReadonlyArray<number>): number =>
    pipe(
      [...points],
      A.reduce(0, (acc, p) => acc + p),
      (total) => (points.length > 0 ? total / points.length : 0),
    ),

  /**
   * Calculate player points in event
   */
  calculatePlayerPoints: (stats: EventPlayerStats): number =>
    pipe(
      [
        stats.minutes > 60 ? 2 : stats.minutes > 0 ? 1 : 0,
        stats.goalsScored * 6,
        stats.assists * 3,
        stats.cleanSheets * 4,
        stats.saves * 1,
        stats.penaltiesSaved * 5,
        stats.penaltiesMissed * -2,
        stats.yellowCards * -1,
        stats.redCards * -3,
        stats.ownGoals * -2,
        stats.goalsConceded > 0 ? Math.floor(stats.goalsConceded / 2) * -1 : 0,
        stats.bonus,
      ],
      A.reduce(0, (acc, points) => acc + points),
    ),

  /**
   * Check if event deadline has passed
   */
  isDeadlinePassed: (event: Event): boolean =>
    pipe(
      TimeOperations.parseDate(event.deadlineTime),
      O.map((date) => TimeOperations.isAfter(new Date(), date)),
      O.getOrElse(() => false),
    ),

  /**
   * Get fixture status based on time
   */
  getFixtureStatus: (fixture: EventFixture): E.Either<string, EventFixture> =>
    pipe(
      TimeOperations.parseDate(fixture.kickoffTime),
      O.map((kickoff) => {
        const now = new Date();
        if (TimeOperations.isAfter(kickoff, now)) {
          return { ...fixture, status: 'scheduled' as FixtureStatus };
        }
        // Note: isWithinMinutes should be implemented in TimeOperations
        const diffInMinutes = Math.abs(now.getTime() - kickoff.getTime()) / (1000 * 60);
        if (diffInMinutes <= 115) {
          return { ...fixture, status: 'live' as FixtureStatus };
        }
        return { ...fixture, status: 'finished' as FixtureStatus };
      }),
      E.fromOption(() => 'Invalid kickoff time'),
    ),

  /**
   * Get event status
   */
  getEventStatus: (event: Event): EventStatus => {
    if (event.isFinished) return 'finished';
    if (event.isCurrent) return 'current';
    return 'upcoming';
  },

  /**
   * Validate event data
   */
  validateEvent: (event: unknown): E.Either<string, Event> => {
    if (!event || typeof event !== 'object') {
      return E.left('Invalid event data');
    }

    // Add more validation logic here
    return E.right(event as Event);
  },

  /**
   * Process live event data
   */
  processLiveEvent: (live: EventLive): EventResult<EventPlayerStats> => {
    try {
      const stats = live.stats;
      const totalPoints = EventOperations.calculatePlayerPoints(stats);

      return {
        success: true,
        data: {
          ...stats,
          totalPoints,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error processing live event',
      };
    }
  },

  /**
   * Sort events by deadline
   */
  sortEventsByDeadline: (events: ReadonlyArray<Event>): ReadonlyArray<Event> =>
    pipe(
      [...events],
      A.sort(
        fromCompare<Event>((a: Event, b: Event) =>
          TimeOperations.compareDesc(
            new Date(a.deadlineTimeEpoch * 1000),
            new Date(b.deadlineTimeEpoch * 1000),
          ),
        ),
      ),
    ),
} as const;
