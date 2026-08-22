import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  ACQUISITION_PROFILES,
  ADAPTER_KINDS,
  CLUB_COVERAGE_ROLES,
  SOURCE_TYPES,
  X_ACQUISITION_LANES,
  type AcquisitionPhase,
  type AdapterKind,
  type XAcquisitionLane,
} from './acquisition-profiles';
import { canonicalJson, type JsonValue } from './canonicalization';

const stableKey = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const xHandle = z
  .string()
  .min(1)
  .max(15)
  .regex(/^[A-Za-z0-9_]+$/);
const youtubeChannelId = z
  .string()
  .length(24)
  .regex(/^UC[A-Za-z0-9_-]{22}$/);
const httpsUrl = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'Only HTTPS source endpoints are allowed',
  });

const endpointLocatorSchema = z
  .object({
    handle: xHandle.optional(),
    url: httpsUrl.optional(),
    channelId: youtubeChannelId.optional(),
    semanticProfileKey: stableKey.optional(),
  })
  .strict();

const sourceEndpointSchema = z
  .object({
    endpointKey: stableKey,
    adapterKind: z.enum(ADAPTER_KINDS),
    locator: endpointLocatorSchema,
    profileKey: stableKey,
    enabled: z.boolean().default(true),
    rightsPolicy: z
      .enum(['PUBLIC_ATTRIBUTED', 'PUBLIC_METADATA_ONLY'])
      .default('PUBLIC_ATTRIBUTED'),
  })
  .strict()
  .superRefine((endpoint, context) => {
    const expectedLocator: Readonly<
      Record<AdapterKind, keyof z.infer<typeof endpointLocatorSchema>>
    > = {
      X_ACCOUNT: 'handle',
      X_SEMANTIC: 'semanticProfileKey',
      RSS_ATOM: 'url',
      PODCAST_FEED: 'url',
      YOUTUBE_CHANNEL: 'channelId',
    };
    const expected = expectedLocator[endpoint.adapterKind];
    const populated = Object.entries(endpoint.locator)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (populated.length !== 1 || populated[0] !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['locator'],
        message: `${endpoint.adapterKind} requires exactly locator.${expected}`,
      });
    }
  });

const clubCoverageSchema = z
  .object({
    clubKey: stableKey,
    role: z.enum(CLUB_COVERAGE_ROLES),
  })
  .strict();

const sourceEntitySchema = z
  .object({
    sourceKey: stableKey,
    sourceType: z.enum(SOURCE_TYPES),
    displayName: z.string().min(1).max(200),
    enabled: z.boolean().default(true),
    origin: z.literal('MANIFEST').default('MANIFEST'),
    clubCoverage: z.array(clubCoverageSchema).max(20).default([]),
    endpoints: z.array(sourceEndpointSchema).min(1).max(20),
  })
  .strict();

export const briefingSourcesManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    entities: z.array(sourceEntitySchema).min(1).max(500),
  })
  .strict();

const partitionSchema = z
  .object({
    partitionKey: stableKey,
    profileKey: stableKey,
    priority: z.number().int().min(1).max(1_000),
    endpointKeys: z.array(stableKey).min(1).max(20),
  })
  .strict();

export const briefingAcquisitionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    seasonKey: z.string().regex(/^\d{4}-\d{2}$/),
    clubKeys: z.array(stableKey).length(20),
    coverage: z
      .object({
        minimumOfficialPerClub: z.number().int().min(1).max(5),
        minimumPrimaryReportingPerClub: z.number().int().min(1).max(5),
      })
      .strict(),
    partitions: z.array(partitionSchema).max(100),
  })
  .strict();

export type BriefingSourcesManifest = z.infer<typeof briefingSourcesManifestSchema>;
export type BriefingAcquisitionPlan = z.infer<typeof briefingAcquisitionPlanSchema>;
export type BriefingSourceEntity = BriefingSourcesManifest['entities'][number];
export type BriefingSourceEndpoint = BriefingSourceEntity['endpoints'][number];

export type ClubCoverageResult = Readonly<{
  clubKey: string;
  officialEntities: readonly string[];
  primaryReportingEntities: readonly string[];
  officialMissing: number;
  primaryReportingMissing: number;
}>;

export type BriefingCoverageReport = Readonly<{
  schemaVersion: 1;
  seasonKey: string;
  manifestHash: string;
  entityCount: number;
  endpointCount: number;
  endpointCounts: Readonly<Record<AdapterKind, number>>;
  partitionCount: number;
  forecastCalls: Readonly<Record<AcquisitionPhase, number>>;
  xForecastWindowMinutes: Readonly<Record<AcquisitionPhase, number>>;
  xLaneForecastCalls: Readonly<
    Record<AcquisitionPhase, Readonly<Record<XAcquisitionLane, number>>>
  >;
  xLaneCallCaps: Readonly<Record<AcquisitionPhase, Readonly<Record<XAcquisitionLane, number>>>>;
  clubs: readonly ClubCoverageResult[];
  fullRolloutEligible: boolean;
}>;

export type BriefingManifestBundle = Readonly<{
  sources: BriefingSourcesManifest;
  plan: BriefingAcquisitionPlan;
  manifestHash: string;
  coverage: BriefingCoverageReport;
}>;

export class BriefingManifestError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Briefing manifest rejected: ${issues.join('; ')}`);
    this.name = 'BriefingManifestError';
    this.issues = issues;
  }
}

function parseYamlDocument(value: string, label: string): unknown {
  const document = parseDocument(value, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new BriefingManifestError(
      document.errors.map((error) => `${label}: ${error.message.replace(/\s+/g, ' ')}`),
    );
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new BriefingManifestError([
      `${label}: ${error instanceof Error ? error.message : 'invalid YAML aliases'}`,
    ]);
  }
}

function zodIssues(label: string, result: z.SafeParseReturnType<unknown, unknown>): string[] {
  if (result.success) return [];
  return result.error.issues.map(
    (issue) => `${label}.${issue.path.join('.') || '<root>'}: ${issue.message}`,
  );
}

function canonicalLocator(endpoint: BriefingSourceEndpoint): string {
  if (endpoint.adapterKind === 'X_ACCOUNT') return `x:${endpoint.locator.handle?.toLowerCase()}`;
  if (endpoint.adapterKind === 'X_SEMANTIC') {
    return `semantic:${endpoint.locator.semanticProfileKey}`;
  }
  if (endpoint.adapterKind === 'YOUTUBE_CHANNEL') {
    return `youtube:${endpoint.locator.channelId}`;
  }
  const url = new URL(endpoint.locator.url ?? 'https://invalid.invalid');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return `${endpoint.adapterKind.toLowerCase()}:${url.toString()}`;
}

function forecastCalls(
  sources: BriefingSourcesManifest,
  plan: BriefingAcquisitionPlan,
): Record<AcquisitionPhase, number> {
  const recurringProfiles = [
    ...plan.partitions.map((partition) => partition.profileKey),
    ...sources.entities.flatMap((entity) =>
      entity.enabled
        ? entity.endpoints
            .filter(
              (endpoint) =>
                endpoint.enabled &&
                endpoint.adapterKind !== 'X_ACCOUNT' &&
                endpoint.adapterKind !== 'X_SEMANTIC',
            )
            .map((endpoint) => endpoint.profileKey)
        : [],
    ),
  ];
  const result: Record<AcquisitionPhase, number> = { NORMAL: 0, APPROACHING: 0, FINAL90: 0 };
  for (const profileKey of recurringProfiles) {
    const profile = ACQUISITION_PROFILES[profileKey];
    if (!profile) continue;
    for (const phase of Object.keys(result) as AcquisitionPhase[]) {
      result[phase] += Math.ceil((24 * 60) / profile.cadenceMinutes[phase]);
    }
  }
  return result;
}

function xLaneForecasts(plan: BriefingAcquisitionPlan): {
  windowMinutes: Record<AcquisitionPhase, number>;
  calls: Record<AcquisitionPhase, Record<XAcquisitionLane, number>>;
  caps: Record<AcquisitionPhase, Record<XAcquisitionLane, number>>;
} {
  const windowMinutes: Record<AcquisitionPhase, number> = {
    NORMAL: 24 * 60,
    APPROACHING: 24 * 60,
    FINAL90: 90,
  };
  const emptyLaneRecord = (): Record<XAcquisitionLane, number> =>
    Object.fromEntries(X_ACQUISITION_LANES.map((lane) => [lane, 0])) as Record<
      XAcquisitionLane,
      number
    >;
  const calls: Record<AcquisitionPhase, Record<XAcquisitionLane, number>> = {
    NORMAL: emptyLaneRecord(),
    APPROACHING: emptyLaneRecord(),
    FINAL90: emptyLaneRecord(),
  };
  for (const partition of plan.partitions) {
    const profile = ACQUISITION_PROFILES[partition.profileKey];
    if (!profile || !X_ACQUISITION_LANES.includes(profile.lane as XAcquisitionLane)) continue;
    const lane = profile.lane as XAcquisitionLane;
    for (const phase of Object.keys(calls) as AcquisitionPhase[]) {
      calls[phase][lane] += Math.ceil(windowMinutes[phase] / profile.cadenceMinutes[phase]);
    }
  }
  const caps = Object.fromEntries(
    (Object.keys(calls) as AcquisitionPhase[]).map((phase) => [
      phase,
      Object.fromEntries(
        X_ACQUISITION_LANES.map((lane) => [lane, Math.ceil(calls[phase][lane] * 1.2)]),
      ),
    ]),
  ) as Record<AcquisitionPhase, Record<XAcquisitionLane, number>>;
  return { windowMinutes, calls, caps };
}

function validateBundle(sources: BriefingSourcesManifest, plan: BriefingAcquisitionPlan): string[] {
  const issues: string[] = [];
  const clubKeys = new Set<string>();
  for (const clubKey of plan.clubKeys) {
    if (clubKeys.has(clubKey)) issues.push(`plan.clubKeys contains duplicate ${clubKey}`);
    clubKeys.add(clubKey);
  }

  const sourceKeys = new Set<string>();
  const endpointKeys = new Map<string, BriefingSourceEndpoint>();
  const activeEndpointKeys = new Set<string>();
  const locators = new Map<string, string>();
  for (const entity of sources.entities) {
    if (sourceKeys.has(entity.sourceKey)) issues.push(`duplicate sourceKey ${entity.sourceKey}`);
    sourceKeys.add(entity.sourceKey);
    if (entity.enabled && !entity.endpoints.some((endpoint) => endpoint.enabled)) {
      issues.push(`enabled source ${entity.sourceKey} has no enabled endpoint`);
    }
    const entityClubRoles = new Set<string>();
    for (const coverage of entity.clubCoverage) {
      const roleKey = `${coverage.clubKey}:${coverage.role}`;
      if (entityClubRoles.has(roleKey)) {
        issues.push(`source ${entity.sourceKey} repeats club coverage ${roleKey}`);
      }
      entityClubRoles.add(roleKey);
      if (!clubKeys.has(coverage.clubKey)) {
        issues.push(`source ${entity.sourceKey} references unknown club ${coverage.clubKey}`);
      }
      if (coverage.role === 'OFFICIAL' && entity.sourceType !== 'CLUB_OFFICIAL') {
        issues.push(
          `source ${entity.sourceKey} claims OFFICIAL coverage but is ${entity.sourceType}`,
        );
      }
      if (entity.sourceType === 'CLUB_OFFICIAL' && coverage.role !== 'OFFICIAL') {
        issues.push(`club official ${entity.sourceKey} cannot claim ${coverage.role}`);
      }
    }
    for (const endpoint of entity.endpoints) {
      if (endpointKeys.has(endpoint.endpointKey)) {
        issues.push(`duplicate endpointKey ${endpoint.endpointKey}`);
      } else {
        endpointKeys.set(endpoint.endpointKey, endpoint);
      }
      if (entity.enabled && endpoint.enabled) activeEndpointKeys.add(endpoint.endpointKey);
      const locator = canonicalLocator(endpoint);
      const previousEndpoint = locators.get(locator);
      if (previousEndpoint) {
        issues.push(
          `duplicate locator ${locator} on ${previousEndpoint} and ${endpoint.endpointKey}`,
        );
      } else {
        locators.set(locator, endpoint.endpointKey);
      }
      const profile = ACQUISITION_PROFILES[endpoint.profileKey];
      if (!profile) {
        issues.push(`endpoint ${endpoint.endpointKey} has unknown profile ${endpoint.profileKey}`);
      } else if (profile.adapterKind !== endpoint.adapterKind) {
        issues.push(
          `endpoint ${endpoint.endpointKey} adapter ${endpoint.adapterKind} does not match profile ${endpoint.profileKey}`,
        );
      }
    }
  }

  const partitionKeys = new Set<string>();
  const partitionMembership = new Map<string, string>();
  for (const partition of plan.partitions) {
    if (partitionKeys.has(partition.partitionKey)) {
      issues.push(`duplicate partitionKey ${partition.partitionKey}`);
    }
    partitionKeys.add(partition.partitionKey);
    const profile = ACQUISITION_PROFILES[partition.profileKey];
    if (!profile || (profile.adapterKind !== 'X_ACCOUNT' && profile.adapterKind !== 'X_SEMANTIC')) {
      issues.push(
        `partition ${partition.partitionKey} has invalid X profile ${partition.profileKey}`,
      );
    } else if (
      profile.partitionMaxMembers !== undefined &&
      partition.endpointKeys.length > profile.partitionMaxMembers
    ) {
      issues.push(
        `partition ${partition.partitionKey} exceeds ${partition.profileKey} member limit ${profile.partitionMaxMembers}`,
      );
    }
    const localMembers = new Set<string>();
    for (const endpointKey of partition.endpointKeys) {
      if (localMembers.has(endpointKey)) {
        issues.push(`partition ${partition.partitionKey} repeats endpoint ${endpointKey}`);
      }
      localMembers.add(endpointKey);
      const endpoint = endpointKeys.get(endpointKey);
      if (!endpoint) {
        issues.push(
          `partition ${partition.partitionKey} references unknown endpoint ${endpointKey}`,
        );
        continue;
      }
      if (endpoint.profileKey !== partition.profileKey) {
        issues.push(
          `partition ${partition.partitionKey} profile does not match endpoint ${endpointKey}`,
        );
      }
      if (!activeEndpointKeys.has(endpointKey)) {
        issues.push(
          `partition ${partition.partitionKey} references disabled endpoint ${endpointKey}`,
        );
      }
      const previousPartition = partitionMembership.get(endpointKey);
      if (previousPartition) {
        issues.push(
          `endpoint ${endpointKey} belongs to ${previousPartition} and ${partition.partitionKey}`,
        );
      } else {
        partitionMembership.set(endpointKey, partition.partitionKey);
      }
    }
  }

  for (const endpoint of endpointKeys.values()) {
    if (
      endpoint.enabled &&
      (endpoint.adapterKind === 'X_ACCOUNT' || endpoint.adapterKind === 'X_SEMANTIC') &&
      !partitionMembership.has(endpoint.endpointKey)
    ) {
      issues.push(`enabled X endpoint ${endpoint.endpointKey} has no recurring partition`);
    }
  }
  return issues;
}

function compileCoverage(
  sources: BriefingSourcesManifest,
  plan: BriefingAcquisitionPlan,
  manifestHash: string,
): BriefingCoverageReport {
  const xForecasts = xLaneForecasts(plan);
  const endpointCounts = Object.fromEntries(ADAPTER_KINDS.map((kind) => [kind, 0])) as Record<
    AdapterKind,
    number
  >;
  for (const entity of sources.entities) {
    if (!entity.enabled) continue;
    for (const endpoint of entity.endpoints) {
      if (endpoint.enabled) endpointCounts[endpoint.adapterKind] += 1;
    }
  }
  const clubs = plan.clubKeys.map((clubKey) => {
    const officialEntities = sources.entities
      .filter(
        (entity) =>
          entity.enabled &&
          entity.endpoints.some((endpoint) => endpoint.enabled) &&
          entity.clubCoverage.some(
            (coverage) => coverage.clubKey === clubKey && coverage.role === 'OFFICIAL',
          ),
      )
      .map((entity) => entity.sourceKey)
      .sort();
    const primaryReportingEntities = sources.entities
      .filter(
        (entity) =>
          entity.enabled &&
          entity.endpoints.some((endpoint) => endpoint.enabled) &&
          entity.clubCoverage.some(
            (coverage) => coverage.clubKey === clubKey && coverage.role === 'PRIMARY_REPORTING',
          ),
      )
      .map((entity) => entity.sourceKey)
      .sort();
    return {
      clubKey,
      officialEntities,
      primaryReportingEntities,
      officialMissing: Math.max(0, plan.coverage.minimumOfficialPerClub - officialEntities.length),
      primaryReportingMissing: Math.max(
        0,
        plan.coverage.minimumPrimaryReportingPerClub - primaryReportingEntities.length,
      ),
    };
  });
  return {
    schemaVersion: 1,
    seasonKey: plan.seasonKey,
    manifestHash,
    entityCount: sources.entities.filter((entity) => entity.enabled).length,
    endpointCount: Object.values(endpointCounts).reduce((total, count) => total + count, 0),
    endpointCounts,
    partitionCount: plan.partitions.length,
    forecastCalls: forecastCalls(sources, plan),
    xForecastWindowMinutes: xForecasts.windowMinutes,
    xLaneForecastCalls: xForecasts.calls,
    xLaneCallCaps: xForecasts.caps,
    clubs,
    fullRolloutEligible: clubs.every(
      (club) => club.officialMissing === 0 && club.primaryReportingMissing === 0,
    ),
  };
}

export function parseBriefingManifest(input: {
  sourcesYaml: string;
  acquisitionPlanYaml: string;
}): BriefingManifestBundle {
  const rawSources = parseYamlDocument(input.sourcesYaml, 'sources');
  const rawPlan = parseYamlDocument(input.acquisitionPlanYaml, 'acquisitionPlan');
  const sourceResult = briefingSourcesManifestSchema.safeParse(rawSources);
  const planResult = briefingAcquisitionPlanSchema.safeParse(rawPlan);
  const schemaIssues = [
    ...zodIssues('sources', sourceResult),
    ...zodIssues('acquisitionPlan', planResult),
  ];
  if (!sourceResult.success || !planResult.success) throw new BriefingManifestError(schemaIssues);
  const issues = validateBundle(sourceResult.data, planResult.data);
  if (issues.length > 0) throw new BriefingManifestError(issues);
  const canonical = canonicalJson({
    sources: sourceResult.data,
    acquisitionPlan: planResult.data,
  } as JsonValue);
  const manifestHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return {
    sources: sourceResult.data,
    plan: planResult.data,
    manifestHash,
    coverage: compileCoverage(sourceResult.data, planResult.data, manifestHash),
  };
}

export async function loadBriefingManifest(input?: {
  sourcesPath?: string;
  acquisitionPlanPath?: string;
}): Promise<BriefingManifestBundle> {
  const sourcesPath = resolve(input?.sourcesPath ?? 'config/briefing/sources.yaml');
  const acquisitionPlanPath = resolve(
    input?.acquisitionPlanPath ?? 'config/briefing/acquisition-plan.yaml',
  );
  const [sourcesYaml, acquisitionPlanYaml] = await Promise.all([
    Bun.file(sourcesPath).text(),
    Bun.file(acquisitionPlanPath).text(),
  ]);
  return parseBriefingManifest({ sourcesYaml, acquisitionPlanYaml });
}
