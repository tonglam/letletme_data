import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { TimeOperations } from '../../shared/time/operations';
import { Event, EventFixture, EventPlayerStats } from './types';

/**
 * Event domain operations
 */
export const EventOperations = {
  /**
   * Calculate event average points
   */
  calculateAveragePoints: (points: ReadonlyArray<number>): number =>
    pipe(
      points,
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
        stats.goals * 6,
        stats.assists * 3,
        stats.cleanSheet ? 4 : 0,
        stats.saves * 1,
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
          return { ...fixture, status: 'scheduled' };
        }
        if (TimeOperations.isWithinMinutes(kickoff, now, 115)) {
          return { ...fixture, status: 'live' };
        }
        return { ...fixture, status: 'finished' };
      }),
      E.fromOption(() => 'Invalid kickoff time'),
    ),
} as const;
