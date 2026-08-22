import { getAcquisitionProfile, type AdapterKind, type SourceType } from './acquisition-profiles';
import type { BriefingManifestBundle } from './acquisition-manifest';

export type DesiredSourceEntity = Readonly<{
  sourceKey: string;
  displayName: string;
  sourceType: SourceType;
  reportingFamily: string;
  status: 'active' | 'paused';
  origin: 'MANIFEST';
  rightsPolicy: Readonly<Record<string, unknown>>;
  manifestRevision: string;
}>;

export type DesiredSourceEndpoint = Readonly<{
  endpointKey: string;
  sourceKey: string;
  adapterKind: AdapterKind;
  profileKey: string;
  locator: Readonly<Record<string, string>>;
  status: 'active' | 'paused';
  origin: 'MANIFEST';
  rightsPolicy: Readonly<Record<string, unknown>>;
  manifestRevision: string;
}>;

export type DesiredSourcePartition = Readonly<{
  partitionKey: string;
  adapterKind: 'X_ACCOUNT' | 'X_SEMANTIC';
  profileKey: string;
  priority: number;
  status: 'active';
  endpointKeys: readonly string[];
  manifestRevision: string;
}>;

export type AcquisitionJobKind = 'X_KEYWORD_SCAN' | 'X_SEMANTIC_SCAN' | 'FEED_POLL';

export type DesiredSourceSchedule = Readonly<{
  scheduleKey: string;
  target: Readonly<
    { kind: 'endpoint'; endpointKey: string } | { kind: 'partition'; partitionKey: string }
  >;
  jobKind: AcquisitionJobKind;
  adapterKind: AdapterKind;
  profileKey: string;
  profileRevision: number;
  priority: number;
  status: 'active';
  manifestRevision: string;
}>;

export type DesiredBriefingRegistryState = Readonly<{
  manifestHash: string;
  entities: readonly DesiredSourceEntity[];
  endpoints: readonly DesiredSourceEndpoint[];
  partitions: readonly DesiredSourcePartition[];
  schedules: readonly DesiredSourceSchedule[];
}>;

function reportingFamily(sourceType: SourceType): string {
  if (
    sourceType === 'OFFICIAL_FPL' ||
    sourceType === 'LEAGUE_OFFICIAL' ||
    sourceType === 'CLUB_OFFICIAL' ||
    sourceType === 'PLAYER_OFFICIAL'
  ) {
    return 'OFFICIAL';
  }
  if (sourceType === 'REPORTER') return 'REPORTER';
  if (sourceType === 'CREATOR') return 'CREATOR';
  if (sourceType === 'PUBLICATION' || sourceType === 'SHOW') return 'LONGFORM';
  if (sourceType === 'AGGREGATOR') return 'AGGREGATOR';
  return 'DISCOVERED';
}

function endpointJobKind(adapterKind: Exclude<AdapterKind, 'X_ACCOUNT' | 'X_SEMANTIC'>) {
  const byAdapter: Readonly<Record<typeof adapterKind, AcquisitionJobKind>> = {
    RSS_ATOM: 'FEED_POLL',
    PODCAST_FEED: 'FEED_POLL',
    YOUTUBE_CHANNEL: 'FEED_POLL',
  };
  return byAdapter[adapterKind];
}

function xJobKind(adapterKind: 'X_ACCOUNT' | 'X_SEMANTIC'): AcquisitionJobKind {
  return adapterKind === 'X_ACCOUNT' ? 'X_KEYWORD_SCAN' : 'X_SEMANTIC_SCAN';
}

function isPublicFeedAdapter(
  adapterKind: AdapterKind,
): adapterKind is Exclude<AdapterKind, 'X_ACCOUNT' | 'X_SEMANTIC'> {
  return adapterKind !== 'X_ACCOUNT' && adapterKind !== 'X_SEMANTIC';
}

function locatorRecord(locator: {
  handle?: string;
  url?: string;
  channelId?: string;
  semanticProfileKey?: string;
}): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(locator).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function compileBriefingRegistryState(
  bundle: BriefingManifestBundle,
): DesiredBriefingRegistryState {
  const entities = bundle.sources.entities
    .map((entity) => ({
      sourceKey: entity.sourceKey,
      displayName: entity.displayName,
      sourceType: entity.sourceType,
      reportingFamily: reportingFamily(entity.sourceType),
      status: entity.enabled ? ('active' as const) : ('paused' as const),
      origin: 'MANIFEST' as const,
      rightsPolicy: { endpointManaged: true },
      manifestRevision: bundle.manifestHash,
    }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));

  const endpoints = bundle.sources.entities
    .flatMap((entity) =>
      entity.endpoints.map((endpoint) => ({
        endpointKey: endpoint.endpointKey,
        sourceKey: entity.sourceKey,
        adapterKind: endpoint.adapterKind,
        profileKey: endpoint.profileKey,
        locator: locatorRecord(endpoint.locator),
        status: entity.enabled && endpoint.enabled ? ('active' as const) : ('paused' as const),
        origin: 'MANIFEST' as const,
        rightsPolicy: { mode: endpoint.rightsPolicy },
        manifestRevision: bundle.manifestHash,
      })),
    )
    .sort((left, right) => left.endpointKey.localeCompare(right.endpointKey));

  const endpointByKey = new Map(endpoints.map((endpoint) => [endpoint.endpointKey, endpoint]));
  const partitions = bundle.plan.partitions
    .map((partition) => {
      const firstEndpoint = endpointByKey.get(partition.endpointKeys[0] ?? '');
      if (
        !firstEndpoint ||
        (firstEndpoint.adapterKind !== 'X_ACCOUNT' && firstEndpoint.adapterKind !== 'X_SEMANTIC')
      ) {
        throw new Error(`Validated partition ${partition.partitionKey} has no X endpoint`);
      }
      return {
        partitionKey: partition.partitionKey,
        adapterKind: firstEndpoint.adapterKind,
        profileKey: partition.profileKey,
        priority: partition.priority,
        status: 'active' as const,
        endpointKeys: [...partition.endpointKeys],
        manifestRevision: bundle.manifestHash,
      };
    })
    .sort((left, right) => left.partitionKey.localeCompare(right.partitionKey));

  const partitionSchedules: DesiredSourceSchedule[] = partitions.map((partition) => {
    const profile = getAcquisitionProfile(partition.profileKey);
    if (!profile) throw new Error(`Validated profile disappeared: ${partition.profileKey}`);
    return {
      scheduleKey: `partition-${partition.partitionKey}`,
      target: { kind: 'partition', partitionKey: partition.partitionKey },
      jobKind: xJobKind(partition.adapterKind),
      adapterKind: partition.adapterKind,
      profileKey: partition.profileKey,
      profileRevision: profile.revision,
      priority: partition.priority,
      status: 'active',
      manifestRevision: bundle.manifestHash,
    };
  });

  const endpointSchedules: DesiredSourceSchedule[] = endpoints
    .filter((endpoint) => endpoint.status === 'active' && isPublicFeedAdapter(endpoint.adapterKind))
    .map((endpoint) => {
      const profile = getAcquisitionProfile(endpoint.profileKey);
      if (!profile) throw new Error(`Validated profile disappeared: ${endpoint.profileKey}`);
      return {
        scheduleKey: `endpoint-${endpoint.endpointKey}`,
        target: { kind: 'endpoint' as const, endpointKey: endpoint.endpointKey },
        jobKind: endpointJobKind(
          endpoint.adapterKind as Exclude<AdapterKind, 'X_ACCOUNT' | 'X_SEMANTIC'>,
        ),
        adapterKind: endpoint.adapterKind,
        profileKey: endpoint.profileKey,
        profileRevision: profile.revision,
        priority: profile.priority,
        status: 'active' as const,
        manifestRevision: bundle.manifestHash,
      };
    });

  return {
    manifestHash: bundle.manifestHash,
    entities,
    endpoints,
    partitions,
    schedules: [...partitionSchedules, ...endpointSchedules].sort((left, right) =>
      left.scheduleKey.localeCompare(right.scheduleKey),
    ),
  };
}
