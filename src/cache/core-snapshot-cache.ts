import type Redis from 'ioredis';

import {
  prepareDataPublication,
  publishDataRevision,
  readActiveDataPublication,
  type DataPublicationDeliveryItem,
  type DataPublicationManifest,
  type PublishDataRevisionOptions,
} from './data-publication';

import type { CoreSnapshot, SelectionRules } from '../domain/core-snapshot';
import type { Event, Fixture, Phase, Player, Team } from '../types';

export interface CoreSnapshotCachePublication {
  readonly published: boolean;
  readonly reason: 'published' | 'stale';
  readonly manifest: DataPublicationManifest;
  readonly previousManifest: DataPublicationManifest | null;
}

export type PreparedCoreSnapshotCachePublication = Readonly<{
  manifest: DataPublicationManifest;
  items: readonly DataPublicationDeliveryItem[];
}>;

export interface CoreSnapshotCacheContents {
  readonly manifest: DataPublicationManifest;
  readonly events: Event[];
  readonly teams: Team[];
  readonly players: Player[];
  readonly phases: Phase[];
  readonly fixtures: Fixture[];
  readonly currentEventId: number | null;
  readonly selectionRules: SelectionRules | null;
}

export interface CoreSnapshotCachePublishOptions
  extends Pick<PublishDataRevisionOptions, 'activate' | 'beforeActivate' | 'afterStage'> {
  readonly revision: number;
  readonly publicationId: string;
  readonly sourceCheckedAt: Date;
  readonly freshnessWindowId?: number;
  readonly redis?: Redis;
}

export function prepareCoreSnapshotCache(
  snapshot: CoreSnapshot,
  options: Pick<
    CoreSnapshotCachePublishOptions,
    'revision' | 'publicationId' | 'sourceCheckedAt' | 'freshnessWindowId'
  >,
): PreparedCoreSnapshotCachePublication {
  return prepareDataPublication({
    dataset: 'fpl:core',
    seasonCode: snapshot.season,
    revision: options.revision,
    publicationId: options.publicationId,
    sourceCheckedAt: options.sourceCheckedAt,
    freshnessWindowId: options.freshnessWindowId,
    state: 'active',
    items: [
      { name: 'events', value: snapshot.events },
      { name: 'teams', value: snapshot.teams },
      { name: 'players', value: snapshot.players },
      { name: 'phases', value: snapshot.phases },
      { name: 'fixtures', value: snapshot.fixtures },
      {
        name: 'currentEventId',
        value: selectCurrentEventIdByDeadline(snapshot.events, options.sourceCheckedAt),
      },
      { name: 'selectionRules', value: snapshot.selectionRules ?? null },
    ],
  });
}

export function selectCurrentEventIdByDeadline(
  events: readonly Event[],
  sourceCheckedAt: Date,
): number | null {
  const now = sourceCheckedAt.getTime();
  const deadline = (event: Event): number =>
    event.deadlineTime ? new Date(event.deadlineTime).getTime() : Number.POSITIVE_INFINITY;
  return (
    events
      .filter((event) => deadline(event) <= now)
      .sort((left, right) => deadline(right) - deadline(left))[0]?.id ?? null
  );
}

export async function publishCoreSnapshotCache(
  snapshot: CoreSnapshot,
  options: CoreSnapshotCachePublishOptions,
): Promise<CoreSnapshotCachePublication> {
  const prepared = prepareCoreSnapshotCache(snapshot, options);
  const result = await publishDataRevision(
    {
      dataset: 'fpl:core',
      seasonCode: snapshot.season,
      revision: options.revision,
      publicationId: options.publicationId,
      sourceCheckedAt: options.sourceCheckedAt,
      freshnessWindowId: options.freshnessWindowId,
      state: 'active',
      items: prepared.items.map((item) => ({
        name: item.manifest.name,
        value: JSON.parse(item.payload) as unknown,
      })),
    },
    {
      redis: options.redis,
      activate: options.activate,
      beforeActivate: options.beforeActivate,
      afterStage: options.afterStage,
    },
  );
  return {
    published: result.status === 'published',
    reason: result.status,
    manifest: result.manifest,
    previousManifest: result.previousManifest,
  };
}

export async function readCoreSnapshotCache(
  seasonCode: string,
  redis?: Redis,
): Promise<CoreSnapshotCacheContents | null> {
  const publication = await readActiveDataPublication({ dataset: 'fpl:core', seasonCode }, redis);
  if (!publication) return null;
  const { items } = publication;
  if (
    !Array.isArray(items.events) ||
    !Array.isArray(items.teams) ||
    !Array.isArray(items.players) ||
    !Array.isArray(items.phases) ||
    !Array.isArray(items.fixtures) ||
    (items.selectionRules !== undefined &&
      items.selectionRules !== null &&
      (typeof items.selectionRules !== 'object' || Array.isArray(items.selectionRules))) ||
    (items.currentEventId !== null && !Number.isInteger(items.currentEventId))
  ) {
    return null;
  }
  return {
    manifest: publication.manifest,
    events: items.events as Event[],
    teams: items.teams as Team[],
    players: items.players as Player[],
    phases: items.phases as Phase[],
    fixtures: items.fixtures as Fixture[],
    currentEventId: items.currentEventId as number | null,
    selectionRules: (items.selectionRules ?? null) as SelectionRules | null,
  };
}
