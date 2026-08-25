import { createHash } from 'node:crypto';

import { getAcquisitionProfile, type AdapterKind, type SourceType } from './acquisition-profiles';
import type { BriefingManifestBundle } from './acquisition-manifest';
import { resolveXIdentityRequirement, type XIdentityRequirement } from './x-identity-policy';

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
  identityRequirement: XIdentityRequirement;
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
  scheduleRole: 'PRIMARY' | 'BACKSTOP';
  target: Readonly<
    { kind: 'endpoint'; endpointKey: string } | { kind: 'partition'; partitionKey: string }
  >;
  jobKind: AcquisitionJobKind;
  adapterKind: AdapterKind;
  profileKey: string;
  profileRevision: number;
  priority: number;
  status: 'active' | 'paused';
  manifestRevision: string;
}>;

export const BACKSTOP_SLOT_MS = 12 * 60 * 60_000;
export const BACKSTOP_START_DELAY_MS = 10 * 60_000;
export const BACKSTOP_JITTER_MAX_MS = 10 * 60_000;

export function deterministicBackstopJitterMs(scheduleKey: string): number {
  const digest = createHash('sha256').update(`backstop:${scheduleKey}`, 'utf8').digest();
  return digest.readUInt32BE(0) % (BACKSTOP_JITTER_MAX_MS + 1);
}

export function latestBackstopSlotEndAt(now: Date): Date {
  const eligibleAt = now.getTime() - BACKSTOP_START_DELAY_MS;
  return new Date(Math.floor(eligibleAt / BACKSTOP_SLOT_MS) * BACKSTOP_SLOT_MS);
}

export function nextBackstopDueAt(now: Date, scheduleKey: string): Date {
  let slotEnd = latestBackstopSlotEndAt(now);
  let due = new Date(
    slotEnd.getTime() + BACKSTOP_START_DELAY_MS + deterministicBackstopJitterMs(scheduleKey),
  );
  while (due.getTime() <= now.getTime()) {
    slotEnd = new Date(slotEnd.getTime() + BACKSTOP_SLOT_MS);
    due = new Date(
      slotEnd.getTime() + BACKSTOP_START_DELAY_MS + deterministicBackstopJitterMs(scheduleKey),
    );
  }
  return due;
}

/**
 * Recover the slot represented by a due BACKSTOP schedule.  Using the
 * current latest slot alone would skip a slot when the scheduler was down
 * across a UTC boundary.  Keep recovery bounded to the last 24 hours; an
 * older overdue schedule starts a fresh latest-slot window instead.
 */
export function backstopSlotEndForDueAt(input: {
  now: Date;
  scheduleKey: string;
  dueAt: Date;
}): Date {
  const latestSlotEnd = latestBackstopSlotEndAt(input.now);
  const inferredMs =
    input.dueAt.getTime() -
    BACKSTOP_START_DELAY_MS -
    deterministicBackstopJitterMs(input.scheduleKey);
  const inferredSlotEnd = new Date(Math.floor(inferredMs / BACKSTOP_SLOT_MS) * BACKSTOP_SLOT_MS);
  if (!Number.isFinite(inferredSlotEnd.getTime())) return latestSlotEnd;
  const oldestRecoverableSlotEnd = new Date(latestSlotEnd.getTime() - BACKSTOP_SLOT_MS);
  if (inferredSlotEnd.getTime() < oldestRecoverableSlotEnd.getTime()) return latestSlotEnd;
  return inferredSlotEnd.getTime() > latestSlotEnd.getTime() ? latestSlotEnd : inferredSlotEnd;
}

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
  options: Readonly<{ includeXBackstop?: boolean }> = {},
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
        identityRequirement: resolveXIdentityRequirement({
          adapterKind: endpoint.adapterKind,
          sourceType: entity.sourceType,
          origin: 'MANIFEST',
        }),
        rightsPolicy: {
          mode: endpoint.rightsPolicy,
          allowPublic: true,
          allowFullText: endpoint.rightsPolicy === 'PUBLIC_ATTRIBUTED',
          attributionRequired: true,
        },
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
      scheduleRole: 'PRIMARY',
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

  // Keep the durable BACKSTOP identity present even while the rollout flag is
  // off.  A disabled rollout pauses these rows; it must not make them
  // disappear, otherwise enabling the flag creates a new schedule identity
  // and loses the ability to audit or resume its slot/checkpoint history.
  const backstopSchedules: DesiredSourceSchedule[] = partitions
    .filter((partition) => partition.adapterKind === 'X_ACCOUNT')
    .map((partition) => {
      const profile = getAcquisitionProfile(partition.profileKey);
      if (!profile) throw new Error(`Validated profile disappeared: ${partition.profileKey}`);
      return {
        scheduleKey: `partition-${partition.partitionKey}-backstop`,
        scheduleRole: 'BACKSTOP' as const,
        target: { kind: 'partition' as const, partitionKey: partition.partitionKey },
        jobKind: 'X_KEYWORD_SCAN' as const,
        adapterKind: 'X_ACCOUNT' as const,
        profileKey: partition.profileKey,
        profileRevision: profile.revision,
        priority: 70,
        status: options.includeXBackstop ? ('active' as const) : ('paused' as const),
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
        scheduleRole: 'PRIMARY',
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
    schedules: [...partitionSchedules, ...backstopSchedules, ...endpointSchedules].sort(
      (left, right) => left.scheduleKey.localeCompare(right.scheduleKey),
    ),
  };
}
