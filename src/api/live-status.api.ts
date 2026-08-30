import { Elysia, t } from 'elysia';

import { readLivePublicationV2 } from '../cache/live-publication-v2';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { liveLifecycleStatusRepository } from '../repositories/live-window';
import { seasonRepository } from '../repositories/seasons';
import { readLivePublicationV2Checkpoint } from '../services/live-publication-v2-checkpoint.service';

export function formatOperationalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const timestamp =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * Read-only operational evidence for the live window. The global API-key
 * guard protects this route in production; it intentionally never calls FPL
 * and never changes readiness state when a publication is absent.
 */
export const liveStatusAPI = new Elysia({ prefix: '/internal/live' }).get(
  '/status',
  async ({ query, set }) => {
    const season = await seasonRepository.findCurrent();
    const event = query.eventId
      ? await eventRepository.findById(season, query.eventId)
      : await eventRepository.findCurrent(season);
    if (!event) {
      set.status = 404;
      return { success: false, code: 'LIVE_EVENT_NOT_FOUND' };
    }

    const [fixtures, lifecycle, redisRead] = await Promise.all([
      fixtureRepository.findByEvent(season, event.id),
      liveLifecycleStatusRepository.findByEventId(season, event.id),
      (async () => {
        try {
          return {
            value: await readLivePublicationV2({ season: season.seasonCode, eventId: event.id }),
            error: null,
          };
        } catch (error) {
          return {
            value: null,
            error: error instanceof Error ? error.name : 'UNKNOWN',
          };
        }
      })(),
    ]);
    const cachedPublication = redisRead.value;
    const checkpointProbe = cachedPublication
      ? { value: null, error: null }
      : await readLivePublicationV2Checkpoint(season, event.id)
          .then((value) => ({ value, error: null }))
          .catch((error) => ({
            value: null,
            error: error instanceof Error ? error.name : 'UNKNOWN',
          }));
    const checkpointRead = checkpointProbe.value;
    const selectedPublication =
      cachedPublication?.publication ?? checkpointRead?.publication ?? null;
    const selectedSource = cachedPublication?.servedFrom ?? checkpointRead?.servedFrom ?? null;
    const finishedFixtures = fixtures.filter(
      (fixture) => fixture.finished || fixture.finishedProvisional,
    ).length;
    const publishedFixtureCount = selectedPublication?.items.fixtures.count ?? null;
    const publishedEventLiveCount = selectedPublication?.items.eventLive.count ?? null;

    return {
      success: true,
      season: season.seasonCode,
      event: {
        id: event.id,
        finished: event.finished,
        dataChecked: event.dataChecked,
      },
      lifecycle: lifecycle
        ? {
            state: lifecycle.state,
            observedAt: formatOperationalTimestamp(lifecycle.observedAt),
            lastChangedAt: formatOperationalTimestamp(lifecycle.lastChangedAt),
            nextRefreshAt: formatOperationalTimestamp(lifecycle.nextRefreshAt),
          }
        : null,
      publication: selectedPublication
        ? {
            generation: selectedPublication.generation,
            publicationId: selectedPublication.publicationId,
            state: selectedPublication.state,
            sourceCheckedAt: selectedPublication.sourceCheckedAt,
            publishedAt: selectedPublication.publishedAt,
            checkpointedAt: selectedPublication.checkpointedAt,
            source: selectedSource,
            fixtureCount: publishedFixtureCount,
            eventLiveCount:
              cachedPublication?.eventLives.length ??
              checkpointRead?.eventLives.length ??
              publishedEventLiveCount,
          }
        : null,
      coverage: {
        fixtures: { finished: finishedFixtures, total: fixtures.length },
        publication: selectedPublication
          ? 'AVAILABLE'
          : checkpointProbe.error
            ? 'UNAVAILABLE'
            : 'NO_NEW_REVISION',
        fallback: {
          redis: redisRead.error ? 'UNAVAILABLE' : cachedPublication ? 'AVAILABLE' : 'EMPTY',
          // Avoid an extra PostgreSQL probe on the healthy Redis path, but do
          // not misreport that unprobed fallback as an empty checkpoint.
          postgres: cachedPublication
            ? 'NOT_CHECKED'
            : checkpointRead
              ? 'AVAILABLE'
              : checkpointProbe.error
                ? 'UNAVAILABLE'
                : 'EMPTY',
          selected: selectedSource ?? 'NONE',
        },
      },
      timestamp: new Date().toISOString(),
    };
  },
  {
    query: t.Object({ eventId: t.Optional(t.Number({ minimum: 1, multipleOf: 1 })) }),
  },
);
