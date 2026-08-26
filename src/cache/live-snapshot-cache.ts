import type Redis from 'ioredis';

import type { EventLive } from '../domain/event-lives';
import type { LiveSnapshotState } from '../domain/live-snapshot';
import type { Fixture } from '../types';
import {
  compareAndSwapDataPublicationPointer,
  publishDataRevision,
  readActiveDataPublication,
  retireActiveDataPublication,
  type DataPublicationManifest,
  type PublishDataRevisionOptions,
} from './data-publication';

export interface LiveSnapshotCachePayload {
  readonly season: string;
  readonly eventId: number;
  readonly state: LiveSnapshotState;
  readonly eventLives: readonly EventLive[];
  readonly fixtures: readonly Fixture[];
}

export interface LiveSnapshotCacheContents extends LiveSnapshotCachePayload {
  readonly manifest: DataPublicationManifest;
}

export interface LiveSnapshotCachePublishOptions
  extends Pick<PublishDataRevisionOptions, 'activate' | 'beforeActivate' | 'afterStage'> {
  readonly revision: number;
  readonly publicationId: string;
  readonly sourceCheckedAt: Date;
  readonly lastSuccessfulFetchAt?: Date;
  readonly redis?: Redis;
}

export interface LiveSnapshotCachePublication {
  readonly published: boolean;
  readonly reason: 'published' | 'stale';
  readonly manifest: DataPublicationManifest;
  readonly previousManifest: DataPublicationManifest | null;
}

export async function publishLiveSnapshotCache(
  payload: LiveSnapshotCachePayload,
  options: LiveSnapshotCachePublishOptions,
): Promise<LiveSnapshotCachePublication> {
  const result = await publishDataRevision(
    {
      dataset: 'fpl:live',
      seasonCode: payload.season,
      eventId: payload.eventId,
      revision: options.revision,
      publicationId: options.publicationId,
      sourceCheckedAt: options.sourceCheckedAt,
      lastSuccessfulFetchAt: options.lastSuccessfulFetchAt,
      state: payload.state,
      items: [
        { name: 'eventLive', value: payload.eventLives },
        { name: 'fixtures', value: payload.fixtures },
      ],
    },
    options,
  );

  return {
    published: result.status === 'published',
    reason: result.status,
    manifest: result.manifest,
    previousManifest: result.previousManifest,
  };
}

/**
 * Refresh the source heartbeat without changing the immutable live payload or
 * revision. The active pointer is swapped with a compare-and-swap so a newer
 * publication cannot be overwritten by a slower unchanged poll.
 */
export async function refreshLiveSnapshotHeartbeat(
  season: string,
  eventId: number,
  lastSuccessfulFetchAt: Date,
  redis?: Redis,
): Promise<LiveSnapshotCacheContents | null> {
  if (!Number.isFinite(lastSuccessfulFetchAt.getTime())) {
    throw new Error('Invalid live snapshot successful-fetch timestamp');
  }
  const active = await readLiveSnapshotCache(season, eventId, redis);
  if (!active) return null;

  const timestamp = lastSuccessfulFetchAt.toISOString();
  const currentTimestamp = active.manifest.lastSuccessfulFetchAt ?? active.manifest.sourceCheckedAt;
  if (Date.parse(currentTimestamp) >= lastSuccessfulFetchAt.getTime()) return active;

  const replacement = {
    ...active.manifest,
    lastSuccessfulFetchAt: timestamp,
  };
  const status = await compareAndSwapDataPublicationPointer(
    { dataset: 'fpl:live', seasonCode: season, eventId },
    active.manifest.publicationId,
    replacement,
    redis,
  );
  if (status === 'replaced') return { ...active, manifest: replacement };
  return readLiveSnapshotCache(season, eventId, redis);
}

export async function readLiveSnapshotCache(
  season: string,
  eventId: number,
  redis?: Redis,
): Promise<LiveSnapshotCacheContents | null> {
  const publication = await readActiveDataPublication(
    { dataset: 'fpl:live', seasonCode: season, eventId },
    redis,
  );
  if (!publication) return null;
  const { items, manifest } = publication;
  if (
    !Array.isArray(items.eventLive) ||
    !Array.isArray(items.fixtures) ||
    (manifest.state !== 'scheduled' && manifest.state !== 'live' && manifest.state !== 'settled')
  ) {
    return null;
  }

  return {
    manifest,
    season,
    eventId,
    state: manifest.state,
    eventLives: items.eventLive as EventLive[],
    fixtures: items.fixtures as Fixture[],
  };
}

/**
 * Read the active immutable live publication only when it matches a caller's
 * request-pinned reference. A changed active pointer is an explicit revision
 * miss; callers must retry with a new reference instead of mixing payloads.
 */
export async function readLiveSnapshotCacheByReference(
  season: string,
  eventId: number,
  reference: { publicationId: string; revision: number | string },
  redis?: Redis,
): Promise<LiveSnapshotCacheContents | null> {
  const snapshot = await readLiveSnapshotCache(season, eventId, redis);
  if (!snapshot) return null;
  return snapshot.manifest.publicationId === reference.publicationId &&
    String(snapshot.manifest.revision) === String(reference.revision)
    ? snapshot
    : null;
}

export async function retireLiveSnapshotCache(
  season: string,
  eventId: number,
  redis?: Redis,
): Promise<DataPublicationManifest | null> {
  return retireActiveDataPublication({ dataset: 'fpl:live', seasonCode: season, eventId }, redis);
}
