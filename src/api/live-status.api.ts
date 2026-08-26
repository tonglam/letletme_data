import { Elysia, t } from 'elysia';

import { readLiveSnapshotCache } from '../cache/live-snapshot-cache';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import {
  liveLifecycleStatusRepository,
  managerScoreCheckpointRepository,
} from '../repositories/live-window';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { seasonRepository } from '../repositories/seasons';

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

    const [fixtures, lifecycle, redisRead, postgresPublicationRead, managerRead] =
      await Promise.all([
        fixtureRepository.findByEvent(season, event.id),
        liveLifecycleStatusRepository.findByEventId(season, event.id),
        (async () => {
          try {
            return { value: await readLiveSnapshotCache(season.seasonCode, event.id), error: null };
          } catch (error) {
            return {
              value: null,
              error: error instanceof Error ? error.name : 'UNKNOWN',
            };
          }
        })(),
        (async () => {
          try {
            return {
              value: await syncOperationsRepository.findActiveLivePublicationEvidence(
                season,
                event.id,
              ),
              error: null,
            };
          } catch (error) {
            return {
              value: null,
              error: error instanceof Error ? error.name : 'UNKNOWN',
            };
          }
        })(),
        (async () => {
          try {
            return {
              value: await managerScoreCheckpointRepository.findCoverageByEvent(season, event.id),
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
    const postgresPublication = postgresPublicationRead.value;
    const selectedPublication = cachedPublication ?? postgresPublication;
    const selectedSource = cachedPublication ? 'REDIS' : postgresPublication ? 'POSTGRES' : null;
    const finishedFixtures = fixtures.filter(
      (fixture) => fixture.finished || fixture.finishedProvisional,
    ).length;
    const publishedFixtureCount =
      selectedPublication?.manifest.items.find((item) => item.name === 'fixtures')?.count ?? null;
    const publishedEventLiveCount =
      selectedPublication?.manifest.items.find((item) => item.name === 'eventLive')?.count ?? null;

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
            observedAt: lifecycle.observedAt.toISOString(),
            lastChangedAt: lifecycle.lastChangedAt.toISOString(),
            nextRefreshAt: lifecycle.nextRefreshAt?.toISOString() ?? null,
          }
        : null,
      publication: selectedPublication
        ? {
            revision: String(selectedPublication.manifest.revision),
            publicationId: selectedPublication.manifest.publicationId,
            state: selectedPublication.manifest.state,
            sourceCheckedAt: selectedPublication.manifest.sourceCheckedAt,
            lastSuccessfulFetchAt:
              selectedPublication.manifest.lastSuccessfulFetchAt ??
              selectedPublication.manifest.sourceCheckedAt,
            source: selectedSource,
            fixtureCount: publishedFixtureCount,
            eventLiveCount: cachedPublication?.eventLives.length ?? publishedEventLiveCount,
          }
        : null,
      coverage: {
        fixtures: { finished: finishedFixtures, total: fixtures.length },
        publication: selectedPublication ? 'AVAILABLE' : 'NO_NEW_REVISION',
        fallback: {
          redis: redisRead.error ? 'UNAVAILABLE' : cachedPublication ? 'AVAILABLE' : 'EMPTY',
          postgres: postgresPublicationRead.error
            ? 'UNAVAILABLE'
            : postgresPublication
              ? 'AVAILABLE'
              : 'EMPTY',
          selected: selectedSource ?? 'NONE',
        },
        manager: managerRead.value
          ? {
              checkpointRows: managerRead.value.checkpointRows,
              scopes: managerRead.value.scopes,
              latestCheckedAt: managerRead.value.latestCheckedAt?.toISOString() ?? null,
            }
          : null,
        managerState: managerRead.error ? 'UNAVAILABLE' : managerRead.value ? 'AVAILABLE' : 'EMPTY',
      },
      timestamp: new Date().toISOString(),
    };
  },
  {
    query: t.Object({ eventId: t.Optional(t.Number({ minimum: 1, multipleOf: 1 })) }),
  },
);
