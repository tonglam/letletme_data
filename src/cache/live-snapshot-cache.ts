import type Redis from 'ioredis';

import type { EventLive } from '../domain/event-lives';
import type { LiveBonusByTeam } from '../domain/live-bonus';
import type { LiveFixturesByTeam, LiveFixturesV2ByTeam } from '../domain/live-fixtures';
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
  readonly liveFixtures: LiveFixturesByTeam;
  readonly liveFixturesV2: LiveFixturesV2ByTeam;
  readonly liveBonus: LiveBonusByTeam;
  readonly liveBonusV2: LiveBonusByTeam;
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
        { name: 'eventLives', value: payload.eventLives },
        { name: 'fixtures', value: payload.fixtures },
        { name: 'liveFixtures', value: payload.liveFixtures },
        { name: 'liveFixturesV2', value: payload.liveFixturesV2 },
        { name: 'liveBonus', value: payload.liveBonus },
        { name: 'liveBonusV2', value: payload.liveBonusV2 },
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
    !Array.isArray(items.eventLives) ||
    !Array.isArray(items.fixtures) ||
    !items.liveFixtures ||
    typeof items.liveFixtures !== 'object' ||
    !items.liveFixturesV2 ||
    typeof items.liveFixturesV2 !== 'object' ||
    !items.liveBonus ||
    typeof items.liveBonus !== 'object' ||
    !items.liveBonusV2 ||
    typeof items.liveBonusV2 !== 'object' ||
    (manifest.state !== 'scheduled' && manifest.state !== 'live' && manifest.state !== 'settled')
  ) {
    return null;
  }

  return {
    manifest,
    season,
    eventId,
    state: manifest.state,
    eventLives: items.eventLives as EventLive[],
    fixtures: items.fixtures as Fixture[],
    liveFixtures: items.liveFixtures as LiveFixturesByTeam,
    liveFixturesV2: items.liveFixturesV2 as LiveFixturesV2ByTeam,
    liveBonus: items.liveBonus as LiveBonusByTeam,
    liveBonusV2: items.liveBonusV2 as LiveBonusByTeam,
  };
}

export async function retireLiveSnapshotCache(
  season: string,
  eventId: number,
  redis?: Redis,
): Promise<DataPublicationManifest | null> {
  return retireActiveDataPublication({ dataset: 'fpl:live', seasonCode: season, eventId }, redis);
}
