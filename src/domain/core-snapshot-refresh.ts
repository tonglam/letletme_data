import { createHash } from 'node:crypto';

import type { Event, Fixture } from '../types';

export type CoreSnapshotRefreshReason =
  | 'missing-publication'
  | 'event-id'
  | 'event-lifecycle'
  | 'fixture-lifecycle'
  | 'kickoff-cutover';

const KICKOFF_CUTOVER_REFRESH_WINDOW_MS = 20 * 60_000;

export type CurrentEventLifecycle = Pick<
  Event,
  'id' | 'isPrevious' | 'isCurrent' | 'isNext' | 'finished' | 'dataChecked'
>;
export type CurrentFixtureLifecycle = Pick<
  Fixture,
  'id' | 'event' | 'kickoffTime' | 'started' | 'finished' | 'finishedProvisional'
>;
type CorePublicationLifecycle = {
  currentEventId: number | null;
  events: readonly CurrentEventLifecycle[];
  fixtures: readonly CurrentFixtureLifecycle[];
};

function fixtureLifecycleKey(fixture: CurrentFixtureLifecycle): string {
  return [
    fixture.id,
    fixture.event,
    fixture.started,
    fixture.finished,
    fixture.finishedProvisional,
  ].join(':');
}

/**
 * One completed reconciliation must not suppress a later lifecycle change in
 * the same event. The period key is therefore derived from the canonical
 * target state (and the reason that opened the repair), never from wall time.
 */
export function coreLifecycleReconcilePeriodKey(
  current: CurrentEventLifecycle,
  currentFixtures: readonly CurrentFixtureLifecycle[],
  reason: CoreSnapshotRefreshReason,
): string {
  const target = JSON.stringify({
    reason,
    event: {
      id: current.id,
      isPrevious: current.isPrevious,
      isCurrent: current.isCurrent,
      isNext: current.isNext,
      finished: current.finished,
      dataChecked: current.dataChecked,
    },
    fixtures: currentFixtures
      .map((fixture) => ({
        id: fixture.id,
        event: fixture.event,
        kickoffTime: fixture.kickoffTime?.toISOString() ?? null,
        started: fixture.started,
        finished: fixture.finished,
        finishedProvisional: fixture.finishedProvisional,
      }))
      .sort((left, right) => left.id - right.id),
  });
  const fingerprint = createHash('sha256').update(target).digest('hex').slice(0, 16);
  return `core-lifecycle-${current.id}-${reason}-${fingerprint}`;
}

/**
 * Detect stale cross-publication lifecycle state, including the kickoff gap in
 * which the deadline-derived current event ID is already correct while the
 * immutable core fixtures still say SCHEDULED.
 */
export function coreSnapshotRefreshReason(
  current: CurrentEventLifecycle | null,
  currentFixtures: readonly CurrentFixtureLifecycle[],
  publication: CorePublicationLifecycle | null,
  now = new Date(),
): CoreSnapshotRefreshReason | null {
  if (!publication) return 'missing-publication';
  if (publication.currentEventId !== (current?.id ?? null)) return 'event-id';
  if (!current) return null;

  const publishedEvent = publication.events.find((event) => event.id === current.id);
  if (
    !publishedEvent ||
    publishedEvent.isPrevious !== current.isPrevious ||
    publishedEvent.isCurrent !== current.isCurrent ||
    publishedEvent.isNext !== current.isNext ||
    publishedEvent.finished !== current.finished ||
    publishedEvent.dataChecked !== current.dataChecked
  ) {
    return 'event-lifecycle';
  }

  const storedFixtureKeys = currentFixtures
    .map(fixtureLifecycleKey)
    .sort((left, right) => left.localeCompare(right));
  const publishedFixtures = publication.fixtures.filter((fixture) => fixture.event === current.id);
  const publishedFixtureKeys = publishedFixtures
    .map(fixtureLifecycleKey)
    .sort((left, right) => left.localeCompare(right));
  if (
    storedFixtureKeys.length !== publishedFixtureKeys.length ||
    storedFixtureKeys.some((key, index) => key !== publishedFixtureKeys[index])
  ) {
    return 'fixture-lifecycle';
  }

  const kickoffTimes = publishedFixtures
    .map((fixture) => (fixture.kickoffTime ? new Date(fixture.kickoffTime).getTime() : Number.NaN))
    .filter(Number.isFinite);
  const firstKickoff = kickoffTimes.length > 0 ? Math.min(...kickoffTimes) : null;
  const nowMs = now.getTime();
  const hasLifecycleProgress = publishedFixtures.some(
    (fixture) => fixture.started || fixture.finished || fixture.finishedProvisional,
  );
  if (
    firstKickoff !== null &&
    nowMs >= firstKickoff &&
    nowMs < firstKickoff + KICKOFF_CUTOVER_REFRESH_WINDOW_MS &&
    !hasLifecycleProgress
  ) {
    return 'kickoff-cutover';
  }

  return null;
}
