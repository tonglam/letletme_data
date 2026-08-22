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

    const [fixtures, lifecycle, redisRead, postgresManifest, postgresEventLives, managerCoverage] =
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
        syncOperationsRepository
          .findActivePublicationManifest('fpl:live', season, event.id)
          .catch(() => null),
        syncOperationsRepository.findActiveLiveEventLives(season, event.id).catch(() => null),
        managerScoreCheckpointRepository.findCoverageByEvent(season, event.id).catch(() => null),
      ]);
    const cachedPublication = redisRead.value;
    const postgresPublication =
      postgresManifest && postgresEventLives
        ? {
            manifest: postgresManifest,
            eventLives: postgresEventLives,
          }
        : null;
    const selectedPublication = cachedPublication ?? postgresPublication;
    const selectedSource = cachedPublication ? 'REDIS' : postgresPublication ? 'POSTGRES' : null;
    const finishedFixtures = fixtures.filter(
      (fixture) => fixture.finished || fixture.finishedProvisional,
    ).length;

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
            source: selectedSource,
            fixtureCount: cachedPublication?.fixtures.length ?? null,
            eventLiveCount:
              cachedPublication?.eventLives.length ?? selectedPublication.eventLives.length,
          }
        : null,
      coverage: {
        fixtures: { finished: finishedFixtures, total: fixtures.length },
        publication: selectedPublication ? 'AVAILABLE' : 'NO_NEW_REVISION',
        fallback: {
          redis: redisRead.error ? 'UNAVAILABLE' : cachedPublication ? 'AVAILABLE' : 'EMPTY',
          postgres: postgresPublication ? 'AVAILABLE' : 'EMPTY',
          selected: selectedSource ?? 'NONE',
        },
        manager: managerCoverage
          ? {
              checkpointRows: managerCoverage.checkpointRows,
              scopes: managerCoverage.scopes,
              latestCheckedAt: managerCoverage.latestCheckedAt?.toISOString() ?? null,
            }
          : null,
      },
      timestamp: new Date().toISOString(),
    };
  },
  {
    query: t.Object({ eventId: t.Optional(t.Number({ minimum: 1, multipleOf: 1 })) }),
  },
);
