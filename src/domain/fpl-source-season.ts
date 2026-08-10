import type { Event, Fixture, RawFPLEvent, RawFPLFixture } from '../types';

type EventLike = Pick<RawFPLEvent, 'id' | 'deadline_time'> | Pick<Event, 'id' | 'deadlineTime'>;

type FixtureLike =
  | Pick<RawFPLFixture, 'event' | 'kickoff_time'>
  | Pick<Fixture, 'event' | 'kickoffTime'>;

function seasonCodeFromStartYear(startYear: number): string {
  return `${String(startYear).slice(-2)}${String(startYear + 1).slice(-2)}`;
}

function utcYear(value: string | Date | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear();
}

/**
 * Derive source identity from GW1 payload timestamps. This is only an integrity
 * check against `fpl.seasons.is_current`; it is never current-season authority.
 */
export function deriveFplSeasonFromEvents(events: readonly EventLike[]): string | null {
  const gw1 = events.find((event) => event.id === 1);
  const startYear = gw1
    ? utcYear('deadline_time' in gw1 ? gw1.deadline_time : gw1.deadlineTime)
    : null;
  return startYear === null ? null : seasonCodeFromStartYear(startYear);
}

/** Source-payload identity check matching the earliest scheduled GW1 fixture. */
export function deriveFplSeasonFromFixtures(fixtures: readonly FixtureLike[]): string | null {
  const years = fixtures
    .filter((fixture) => fixture.event === 1)
    .map((fixture) =>
      utcYear('kickoff_time' in fixture ? fixture.kickoff_time : fixture.kickoffTime),
    )
    .filter((year): year is number => year !== null);
  return years.length === 0 ? null : seasonCodeFromStartYear(Math.min(...years));
}
