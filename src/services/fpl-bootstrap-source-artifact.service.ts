import { createHash, randomUUID } from 'node:crypto';

import {
  BootstrapResponseSchema,
  fplClient,
  type FPLBootstrapArtifactResponse,
  type FPLBootstrapResponse,
} from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  fplSourceArtifactsRepository,
  type FplSourceArtifact,
  type FplSourceArtifactCounts,
} from '../repositories/fpl-source-artifacts';
import { getConfig } from '../utils/config';
import { logInfo } from '../utils/logger';
import { formatCronDateKey } from '../utils/timezone';
import {
  createFplSourceArtifactStorage,
  type FplSourceArtifactObject,
  type FplSourceArtifactStorage,
} from './fpl-source-artifact-storage.service';

const CONTENT_TYPE = 'application/json' as const;
const SOURCE_TIMEZONE = 'Asia/Shanghai' as const;
const DATASET = 'bootstrap-static';

export class FplBootstrapSourceArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FplBootstrapSourceArtifactError';
    this.code = code;
  }
}

export type ResolvedFplBootstrapArtifact = Readonly<{
  artifact: FplSourceArtifact;
  bootstrap: FPLBootstrapResponse;
  provenance: 'captured' | 'archive';
}>;

export type FplBootstrapSourceArtifactDependencies = Readonly<{
  captureBootstrap: () => Promise<FPLBootstrapArtifactResponse>;
  findLatestForDay: typeof fplSourceArtifactsRepository.findLatestForDay;
  insertIfAbsent: typeof fplSourceArtifactsRepository.insertIfAbsent;
  getStorage: () => FplSourceArtifactStorage;
  bucket: string;
  now: () => Date;
}>;

function defaultStorage(): FplSourceArtifactStorage {
  const config = getConfig();
  if (
    !config.FPL_RAW_SNAPSHOT_STORAGE_ENABLED ||
    !config.FPL_RAW_SNAPSHOT_SUPABASE_URL ||
    !config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY ||
    config.FPL_RAW_SNAPSHOT_BUCKET !== 'fpl-raw-snapshots'
  ) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_NOT_CONFIGURED',
      'FPL raw bootstrap archive is not configured',
    );
  }
  return createFplSourceArtifactStorage({
    supabaseUrl: config.FPL_RAW_SNAPSHOT_SUPABASE_URL,
    secretKey: config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY,
    bucket: config.FPL_RAW_SNAPSHOT_BUCKET,
  });
}

const defaultDependencies: FplBootstrapSourceArtifactDependencies = {
  captureBootstrap: () => fplClient.getBootstrapArtifact(),
  findLatestForDay: (season, sourceDay) =>
    fplSourceArtifactsRepository.findLatestForDay(season, sourceDay),
  insertIfAbsent: (artifact) => fplSourceArtifactsRepository.insertIfAbsent(artifact),
  getStorage: defaultStorage,
  bucket: 'fpl-raw-snapshots',
  now: () => new Date(),
};

function assertSourceDay(sourceDay: string): void {
  if (!/^\d{8}$/.test(sourceDay)) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_DAY_INVALID',
      `Invalid FPL bootstrap source day: ${sourceDay}`,
    );
  }
  const year = Number(sourceDay.slice(0, 4));
  const month = Number(sourceDay.slice(4, 6));
  const day = Number(sourceDay.slice(6, 8));
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_DAY_INVALID',
      `Invalid FPL bootstrap source day: ${sourceDay}`,
    );
  }
}

function itemCounts(bootstrap: FPLBootstrapResponse): FplSourceArtifactCounts {
  return {
    events: bootstrap.events.length,
    teams: bootstrap.teams.length,
    elements: bootstrap.elements.length,
    phases: bootstrap.phases.length,
  };
}

function assertCounts(
  expected: FplSourceArtifactCounts,
  actual: FplSourceArtifactCounts,
  artifactId: string,
): void {
  for (const key of ['events', 'teams', 'elements', 'phases'] as const) {
    if (expected[key] !== actual[key]) {
      throw new FplBootstrapSourceArtifactError(
        'FPL_SOURCE_ARCHIVE_COUNT_MISMATCH',
        `FPL bootstrap artifact ${artifactId} ${key} count does not match its manifest`,
      );
    }
  }
}

function assertSeasonIdentity(bootstrap: FPLBootstrapResponse, season: FplSeasonRef): void {
  if (season.seasonId !== 2000 + Number(season.seasonCode.slice(0, 2))) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_SEASON_INVALID',
      `FPL season reference ${season.seasonCode} is inconsistent`,
    );
  }
  const allowedYears = new Set([season.seasonId, season.seasonId + 1]);
  const datedEvents = bootstrap.events.flatMap((event) =>
    [event.deadline_time, event.release_time]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => new Date(value)),
  );
  if (datedEvents.length === 0 || datedEvents.some((date) => !Number.isFinite(date.getTime()))) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_SEASON_UNPROVABLE',
      `FPL bootstrap does not contain valid event dates for season ${season.seasonCode}`,
    );
  }
  if (datedEvents.some((date) => !allowedYears.has(date.getUTCFullYear()))) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_SEASON_MISMATCH',
      `FPL bootstrap event dates do not belong to season ${season.seasonCode}`,
    );
  }
}

function normalizeContentType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseBootstrap(bytes: Uint8Array, artifactId: string): FPLBootstrapResponse {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return BootstrapResponseSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_SCHEMA_INVALID',
      `FPL bootstrap artifact ${artifactId} is not valid canonical bootstrap JSON`,
      error instanceof Error ? error : undefined,
    );
  }
}

function assertSourceUrl(sourceUrl: string): void {
  const parsed = new URL(sourceUrl);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'fantasy.premierleague.com' ||
    parsed.pathname !== '/api/bootstrap-static/'
  ) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_URL_INVALID',
      'FPL bootstrap artifact source URL is invalid',
    );
  }
}

async function loadAndValidateArchive(
  season: FplSeasonRef,
  sourceDay: string,
  artifact: FplSourceArtifact,
  storage: FplSourceArtifactStorage,
  bucket: string,
): Promise<FPLBootstrapResponse> {
  if (artifact.seasonId !== season.seasonId || artifact.sourceDay !== sourceDay) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_IDENTITY_MISMATCH',
      `FPL bootstrap artifact ${artifact.artifactId} does not match the requested season/day`,
    );
  }
  if (artifact.bucket !== bucket || artifact.contentType !== CONTENT_TYPE) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_STORAGE_MISMATCH',
      `FPL bootstrap artifact ${artifact.artifactId} has unexpected storage metadata`,
    );
  }
  if (formatCronDateKey(artifact.retrievedAt) !== sourceDay) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_DAY_MISMATCH',
      `FPL bootstrap artifact ${artifact.artifactId} retrieval time is outside its source day`,
    );
  }
  const expectedObjectKey = `fpl/${DATASET}/${season.seasonCode}/${sourceDay}/${artifact.sha256}.json`;
  if (artifact.objectKey !== expectedObjectKey) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_OBJECT_KEY_MISMATCH',
      `FPL bootstrap artifact ${artifact.artifactId} object key is invalid`,
    );
  }
  assertSourceUrl(artifact.sourceUrl);

  let stored: FplSourceArtifactObject;
  try {
    stored = await storage.download(artifact.objectKey);
  } catch (error) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_UNAVAILABLE',
      `FPL bootstrap artifact ${artifact.artifactId} cannot be read from object storage`,
      error instanceof Error ? error : undefined,
    );
  }
  if (normalizeContentType(stored.contentType) !== CONTENT_TYPE) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_CONTENT_TYPE_MISMATCH',
      `FPL bootstrap artifact ${artifact.artifactId} actual content type is invalid`,
    );
  }
  if (
    stored.bytes.byteLength !== artifact.byteSize ||
    (stored.declaredByteSize !== null && stored.declaredByteSize !== artifact.byteSize)
  ) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_SIZE_MISMATCH',
      `FPL bootstrap artifact ${artifact.artifactId} byte size does not match its manifest`,
    );
  }
  if (sha256(stored.bytes) !== artifact.sha256) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_HASH_MISMATCH',
      `FPL bootstrap artifact ${artifact.artifactId} hash does not match its manifest`,
    );
  }
  const bootstrap = parseBootstrap(stored.bytes, artifact.artifactId);
  assertSeasonIdentity(bootstrap, season);
  assertCounts(artifact.itemCounts, itemCounts(bootstrap), artifact.artifactId);
  return bootstrap;
}

async function captureCurrentDay(
  season: FplSeasonRef,
  sourceDay: string,
  dependencies: FplBootstrapSourceArtifactDependencies,
): Promise<ResolvedFplBootstrapArtifact> {
  const captured = await dependencies.captureBootstrap();
  if (captured.contentType !== CONTENT_TYPE || captured.bytes.byteLength === 0) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_CAPTURE_INVALID',
      'FPL bootstrap capture has invalid bytes or content type',
    );
  }
  if (formatCronDateKey(captured.retrievedAt) !== sourceDay) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_CAPTURE_DAY_CHANGED',
      `FPL bootstrap capture crossed the requested source-day boundary ${sourceDay}`,
    );
  }
  assertSourceUrl(captured.sourceUrl);
  assertSeasonIdentity(captured.payload, season);
  const digest = sha256(captured.bytes);
  const objectKey = `fpl/${DATASET}/${season.seasonCode}/${sourceDay}/${digest}.json`;
  const storage = dependencies.getStorage();
  await storage.uploadImmutable(objectKey, captured.bytes);

  // A successful upload response alone is weaker than durable evidence. Read
  // the private object back and validate the exact bytes before recording the
  // immutable manifest row that enables replay.
  const roundtrip = await storage.download(objectKey);
  if (
    normalizeContentType(roundtrip.contentType) !== CONTENT_TYPE ||
    roundtrip.bytes.byteLength !== captured.bytes.byteLength ||
    (roundtrip.declaredByteSize !== null &&
      roundtrip.declaredByteSize !== captured.bytes.byteLength) ||
    sha256(roundtrip.bytes) !== digest
  ) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_CAPTURE_ROUNDTRIP_MISMATCH',
      'FPL bootstrap capture did not roundtrip through object storage exactly',
    );
  }

  const artifact = await dependencies.insertIfAbsent({
    artifactId: randomUUID(),
    seasonId: season.seasonId,
    sourceDay,
    sourceTimezone: SOURCE_TIMEZONE,
    sourceUrl: captured.sourceUrl,
    bucket: dependencies.bucket,
    objectKey,
    sha256: digest,
    byteSize: captured.bytes.byteLength,
    contentType: CONTENT_TYPE,
    retrievedAt: captured.retrievedAt,
    schemaVersion: 1,
    itemCounts: itemCounts(captured.payload),
  });
  const bootstrap = await loadAndValidateArchive(
    season,
    sourceDay,
    artifact,
    storage,
    dependencies.bucket,
  );
  logInfo('Archived exact FPL bootstrap source artifact', {
    artifactId: artifact.artifactId,
    season: season.seasonCode,
    sourceDay,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    objectKey: artifact.objectKey,
  });
  return { artifact, bootstrap, provenance: 'captured' };
}

export async function resolveFplBootstrapSourceArtifact(
  season: FplSeasonRef,
  sourceDay: string,
  dependencies: FplBootstrapSourceArtifactDependencies = defaultDependencies,
): Promise<ResolvedFplBootstrapArtifact> {
  assertSourceDay(sourceDay);
  const currentSourceDay = formatCronDateKey(dependencies.now());
  if (sourceDay > currentSourceDay) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_DAY_FUTURE',
      `FPL bootstrap source day ${sourceDay} is in the future`,
    );
  }
  if (sourceDay === currentSourceDay) {
    return captureCurrentDay(season, sourceDay, dependencies);
  }

  // Historical replay is archive-only by construction. There is deliberately
  // no provider-network fallback in this branch.
  const artifact = await dependencies.findLatestForDay(season, sourceDay);
  if (!artifact) {
    throw new FplBootstrapSourceArtifactError(
      'FPL_SOURCE_ARCHIVE_MISSING',
      `No immutable FPL bootstrap archive exists for ${season.seasonCode}/${sourceDay}`,
    );
  }
  const bootstrap = await loadAndValidateArchive(
    season,
    sourceDay,
    artifact,
    dependencies.getStorage(),
    dependencies.bucket,
  );
  logInfo('Loaded historical FPL bootstrap exclusively from source-day archive', {
    artifactId: artifact.artifactId,
    season: season.seasonCode,
    sourceDay,
    sha256: artifact.sha256,
  });
  return { artifact, bootstrap, provenance: 'archive' };
}
