import type Redis from 'ioredis';

import type { EventLive } from '../domain/event-lives';
import type { LiveSnapshotState } from '../domain/live-snapshot';
import type { Fixture } from '../types';
import {
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
  extends Pick<PublishDataRevisionOptions, 'beforeActivate' | 'afterStage'> {
  readonly revision: number;
  readonly publicationId: string;
  readonly sourceCheckedAt: Date;
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

export async function retireLiveSnapshotCache(
  season: string,
  eventId: number,
  redis?: Redis,
): Promise<DataPublicationManifest | null> {
  return retireActiveDataPublication({ dataset: 'fpl:live', seasonCode: season, eventId }, redis);
}
