import { createHash, randomUUID } from 'node:crypto';

import {
  BootstrapResponseSchema,
  type FPLBootstrapArtifactResponse,
  type FPLBootstrapResponse,
} from '../clients/fpl';
import {
  normalizePriceChangeBoard,
  PRICE_CHANGE_READY_MS,
  priceChangeTriggerFingerprint,
  PriceChangePredictionValidationError,
  validatePriceChangeObservedEvent,
  type PriceChangeBoard,
  type PriceChangeHotEventEvidence,
  type PriceChangeObservedEvent,
} from './price-change-predictions.service';
import { deriveFplSeasonFromEvents } from '../domain/fpl-source-season';
import type { FplSeasonRef } from '../domain/fpl-season';
import { parsePersistedDataError, summarizeDataError } from '../domain/error-classification';
import { redisSingleton } from '../cache/singleton';
import { getConfig } from '../utils/config';
import { logInfo } from '../utils/logger';
import { createFplSourceArtifactStorage } from './fpl-source-artifact-storage.service';

export const PRICE_CHANGE_HOT_TTL_MS = 15 * 60 * 1000;
// The metadata-only cursor includes the validated deadline horizon. Bump the
// envelope version whenever that shape changes so an older payload cannot be
// advertised without the same validation evidence.
export const PRICE_CHANGE_HOT_SCHEMA_VERSION = 4 as const;
export type PriceChangeHotSchemaVersion = 3 | 4;

const HOT_KEY_PREFIX = 'fpl:price-changes:hot';

export type PriceChangeHotReconciliationState = 'pending' | 'reconciled' | 'failed';

/** Prefix persisted in reconciliation metadata when the exact source archive is unavailable. */
export const PRICE_CHANGE_HOT_ARCHIVE_FAILURE_PREFIX = 'source-archive-failed:';

export type PriceChangeHotSnapshot = Readonly<{
  schemaVersion: PriceChangeHotSchemaVersion;
  seasonCode: string;
  revision: string;
  triggerFingerprint: string;
  sourceHash: string;
  /** Hash of the immutable payload envelope, excluding reconciliation state. */
  payloadHash: string;
  /** Hash of the immutable metadata envelope, excluding reconciliation state. */
  metadataHash: string;
  artifactId: string | null;
  deadline: string | null;
  nextDeadlines: readonly string[];
  detectedAt: string;
  fetchedAt: string;
  expiresAt: string;
  expectedPlayerCount: number;
  observedPlayerCount: number;
  corePlayerCount: number | null;
  corePlayerDelta: number | null;
  board: PriceChangeBoard;
  reconciliation: Readonly<{
    state: PriceChangeHotReconciliationState;
    durablePublicationId: string | null;
    durableRevision: number | null;
    error: string | null;
  }>;
}>;

export type PriceChangeHotCursor = Readonly<{
  seasonCode: string;
  revision: string;
  detectedAt: string;
  fetchedAt: string;
  expiresAt: string;
  state: 'PROVISIONAL' | 'STALE' | 'RECONCILED' | 'FAILED';
  reconciliationError: string | null;
}>;

/** Expose the immutable hot revision needed by durable publication fences. */
export function priceChangeHotEventEvidence(
  snapshot: PriceChangeHotSnapshot | null | undefined,
): PriceChangeHotEventEvidence | null {
  if (!snapshot || snapshot.schemaVersion < 4 || !snapshot.board.latestEvent) {
    return null;
  }
  return {
    event: snapshot.board.latestEvent,
    revision: snapshot.revision,
    sourceHash: snapshot.sourceHash,
    artifactId: snapshot.artifactId,
    detectedAt: snapshot.detectedAt,
    fetchedAt: snapshot.fetchedAt,
  };
}

const DURABLE_PUBLICATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Return whether a valid hot board is newer than the durable board.
 *
 * `detectedAt` is captured before the provider request starts and is therefore
 * the source-order timestamp for a hot response.  Do not use `fetchedAt` here:
 * a slow response can finish after a newer durable request and otherwise make
 * an older hot payload win the resolver race until the hot TTL expires.
 */
export function isPriceChangeHotSnapshotNewer(
  snapshot: PriceChangeHotSnapshot | null,
  durable: PriceChangeBoard,
): snapshot is PriceChangeHotSnapshot {
  if (!snapshot || durable.status === 'UNAVAILABLE' || !durable.fetchedAt) {
    return Boolean(snapshot);
  }
  const hotAt = Date.parse(snapshot.detectedAt);
  const durableAt = Date.parse(durable.sourceCheckedAt ?? durable.fetchedAt);
  return Number.isFinite(hotAt) && (!Number.isFinite(durableAt) || hotAt > durableAt);
}

export function priceChangeHotPointerKey(seasonCode: string): string {
  return `${HOT_KEY_PREFIX}:${seasonCode}:active`;
}

export function priceChangeHotPayloadKey(
  seasonCode: string,
  revision: string,
  sourceHash: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) {
    throw new Error('Price-change hot source hash is invalid');
  }
  return `${HOT_KEY_PREFIX}:${seasonCode}:${revision}:${sourceHash}`;
}

/**
 * Persist only bounded, classified reconciliation evidence.  Hot snapshots
 * are read by operational status tooling, so provider URLs, identifiers and
 * stack/message details must never be the only durable representation of a
 * terminal failure.
 */
export function formatPriceChangeHotError(error: unknown): string {
  if (typeof error === 'string' && error.startsWith(PRICE_CHANGE_HOT_ARCHIVE_FAILURE_PREFIX)) {
    const detail = error.slice(PRICE_CHANGE_HOT_ARCHIVE_FAILURE_PREFIX.length).trim();
    const summary = summarizeDataError(new Error(detail));
    return `SOURCE_ARCHIVE_MISSING:SOURCE_ARCHIVE_MISSING ${summary.summary}`.slice(0, 1_000);
  }

  if (typeof error === 'string') {
    const parsed = parsePersistedDataError(error);
    if (parsed) {
      const detail = error.slice(parsed.prefixLength).trim();
      const summary = detail ? summarizeDataError(new Error(detail)).summary : '';
      return `${parsed.errorClass}:${parsed.errorCode}${summary ? ` ${summary}` : ''}`.slice(
        0,
        1_000,
      );
    }
  }

  const summary = summarizeDataError(error);
  return `${summary.errorClass}:${summary.errorCode} ${summary.summary}`.slice(0, 1_000);
}

/** Redis index retaining source-bound payload keys for a board revision. */
function priceChangeHotRevisionIndexKey(seasonCode: string, revision: string): string {
  return `${HOT_KEY_PREFIX}:${seasonCode}:revision:${revision}:sources`;
}

/** Small metadata envelope used by cursor polling without loading the board. */
export function priceChangeHotMetadataKey(
  seasonCode: string,
  revision: string,
  sourceHash: string,
): string {
  return `${priceChangeHotPayloadKey(seasonCode, revision, sourceHash)}:metadata`;
}

type PriceChangeHotSnapshotMetadata = Omit<PriceChangeHotSnapshot, 'board'>;

type HotSnapshotRecord = Record<string, unknown>;

const immutablePayloadJson = (value: HotSnapshotRecord): string => {
  const {
    payloadHash: _payloadHash,
    metadataHash: _metadataHash,
    reconciliation: _reconciliation,
    ...immutable
  } = value;
  return JSON.stringify(immutable);
};

const immutableMetadataJson = (value: HotSnapshotRecord): string => {
  const {
    metadataHash: _metadataHash,
    reconciliation: _reconciliation,
    board: _board,
    ...immutable
  } = value;
  return JSON.stringify(immutable);
};

const hotPayloadHash = (value: HotSnapshotRecord): string =>
  sha256Bytes(new TextEncoder().encode(immutablePayloadJson(value)));

const hotMetadataHash = (value: HotSnapshotRecord): string =>
  sha256Bytes(new TextEncoder().encode(immutableMetadataJson(value)));

function priceChangeHotSnapshotMetadata(snapshot: PriceChangeHotSnapshot): string {
  const metadata: PriceChangeHotSnapshotMetadata = {
    schemaVersion: snapshot.schemaVersion,
    seasonCode: snapshot.seasonCode,
    revision: snapshot.revision,
    triggerFingerprint: snapshot.triggerFingerprint,
    sourceHash: snapshot.sourceHash,
    payloadHash: snapshot.payloadHash,
    metadataHash: snapshot.metadataHash,
    artifactId: snapshot.artifactId,
    deadline: snapshot.deadline,
    nextDeadlines: snapshot.nextDeadlines,
    detectedAt: snapshot.detectedAt,
    fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.expiresAt,
    expectedPlayerCount: snapshot.expectedPlayerCount,
    observedPlayerCount: snapshot.observedPlayerCount,
    corePlayerCount: snapshot.corePlayerCount,
    corePlayerDelta: snapshot.corePlayerDelta,
    reconciliation: snapshot.reconciliation,
  };
  return JSON.stringify(metadata);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Allocate the source artifact identity before the hot write. The upload is
 * deliberately performed after Redis publication so object storage latency
 * cannot delay the user-visible price board.
 */
export function createPriceChangeHotArtifactId(): string {
  return randomUUID();
}

/** Archive an exact watcher response without making the archive a hot-path dependency. */
export async function archivePriceChangeHotSource(input: {
  artifactId: string;
  bytes: Uint8Array;
  sourceHash: string;
}): Promise<{ readonly artifactId: string; readonly objectKey: string }> {
  const config = getConfig();
  if (
    !config.FPL_RAW_SNAPSHOT_STORAGE_ENABLED ||
    !config.FPL_RAW_SNAPSHOT_SUPABASE_URL ||
    !config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY
  ) {
    throw new Error('FPL raw bootstrap archive is not configured for hot source capture');
  }
  const bucket = config.FPL_RAW_SNAPSHOT_BUCKET ?? 'fpl-raw-snapshots';
  if (sha256Bytes(input.bytes) !== input.sourceHash) {
    throw new Error('Price-change hot source hash does not match captured bytes');
  }
  if (!/^[0-9a-f-]{36}$/.test(input.artifactId)) {
    throw new Error('Price-change hot source artifact ID is invalid');
  }
  const objectKey = `probes/${input.artifactId}.json`;
  const storage = createFplSourceArtifactStorage({
    supabaseUrl: config.FPL_RAW_SNAPSHOT_SUPABASE_URL,
    secretKey: config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY,
    bucket,
  });
  await storage.uploadImmutable(objectKey, input.bytes);
  const roundtrip = await storage.download(objectKey);
  if (
    roundtrip.contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' ||
    roundtrip.bytes.byteLength !== input.bytes.byteLength ||
    sha256Bytes(roundtrip.bytes) !== input.sourceHash
  ) {
    throw new Error('Price-change hot source archive roundtrip mismatch');
  }
  logInfo('Archived exact FPL bootstrap source for price-change hot snapshot', {
    artifactId: input.artifactId,
    objectKey,
    sourceHash: input.sourceHash,
    byteSize: input.bytes.byteLength,
  });
  return { artifactId: input.artifactId, objectKey };
}

/** Read an archived watcher response for durable reconciliation, if available. */
export async function loadPriceChangeHotSource(input: {
  artifactId: string;
  sourceHash: string;
}): Promise<FPLBootstrapArtifactResponse> {
  const config = getConfig();
  if (
    !config.FPL_RAW_SNAPSHOT_STORAGE_ENABLED ||
    !config.FPL_RAW_SNAPSHOT_SUPABASE_URL ||
    !config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY
  ) {
    throw new Error('FPL raw bootstrap archive is not configured for hot source replay');
  }
  const bucket = config.FPL_RAW_SNAPSHOT_BUCKET ?? 'fpl-raw-snapshots';
  if (!/^[0-9a-f-]{36}$/.test(input.artifactId) || !/^[0-9a-f]{64}$/.test(input.sourceHash)) {
    throw new Error('Price-change hot source identity is invalid');
  }
  const storage = createFplSourceArtifactStorage({
    supabaseUrl: config.FPL_RAW_SNAPSHOT_SUPABASE_URL,
    secretKey: config.FPL_RAW_SNAPSHOT_SUPABASE_SECRET_KEY,
    bucket,
  });
  const bytes = (await storage.download(`probes/${input.artifactId}.json`)).bytes;
  if (sha256Bytes(bytes) !== input.sourceHash) {
    throw new Error('Price-change hot source replay hash mismatch');
  }
  let payload: FPLBootstrapResponse;
  try {
    payload = BootstrapResponseSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    throw new Error(
      `Price-change hot source replay schema invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    bytes,
    payload,
    sourceUrl: 'https://fantasy.premierleague.com/api/bootstrap-static/',
    contentType: 'application/json',
    retrievedAt: new Date(),
  };
}

/**
 * A hot board is derived from one validated bootstrap and intentionally does
 * not require the active Core publication. Core consistency is a durable
 * reconciliation concern, not a reason to hide an official price move.
 */
export function buildPriceChangeHotSnapshot(input: {
  season: FplSeasonRef;
  bootstrap: FPLBootstrapResponse;
  sourceHash: string;
  artifactId?: string | null;
  detectedAt?: Date;
  fetchedAt?: Date;
  corePlayerCount?: number | null;
  corePlayerDelta?: number | null;
  latestEvent?: PriceChangeObservedEvent | null;
}): PriceChangeHotSnapshot {
  const detectedAt = input.detectedAt ?? new Date();
  const fetchedAt = input.fetchedAt ?? detectedAt;
  if (!Number.isFinite(detectedAt.getTime()) || !Number.isFinite(fetchedAt.getTime())) {
    throw new Error('Price-change hot snapshot timestamps are invalid');
  }
  const sourceSeason = deriveFplSeasonFromEvents(input.bootstrap.events);
  if (!sourceSeason) {
    throw new PriceChangePredictionValidationError(
      'FPL bootstrap season cannot be derived from events',
    );
  }
  if (sourceSeason !== input.season.seasonCode) {
    throw new PriceChangePredictionValidationError(
      `FPL bootstrap season ${sourceSeason} does not match current season ${input.season.seasonCode}`,
    );
  }
  const board = normalizePriceChangeBoard(
    input.bootstrap,
    fetchedAt,
    undefined,
    undefined,
    input.latestEvent ?? null,
  );
  if (board.latestEvent) {
    validatePriceChangeObservedEvent(board.latestEvent, board.players, {
      requireCurrentPriceMatch: true,
    });
  }
  const expiresAt = new Date(detectedAt.getTime() + PRICE_CHANGE_HOT_TTL_MS);
  const base = {
    schemaVersion: PRICE_CHANGE_HOT_SCHEMA_VERSION,
    seasonCode: input.season.seasonCode,
    revision: board.revision,
    triggerFingerprint: priceChangeTriggerFingerprint(input.bootstrap),
    sourceHash: input.sourceHash,
    payloadHash: '',
    metadataHash: '',
    artifactId: input.artifactId ?? null,
    deadline: board.deadline,
    nextDeadlines: [...board.nextDeadlines],
    detectedAt: detectedAt.toISOString(),
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    expectedPlayerCount: board.expectedPlayerCount,
    observedPlayerCount: board.observedPlayerCount,
    corePlayerCount: input.corePlayerCount ?? null,
    corePlayerDelta: input.corePlayerDelta ?? null,
    board,
    reconciliation: {
      state: 'pending',
      durablePublicationId: null,
      durableRevision: null,
      error: null,
    },
  } as const;
  const payloadHash = hotPayloadHash(base);
  const withPayloadHash = { ...base, payloadHash };
  const metadataHash = hotMetadataHash(withPayloadHash);
  return { ...withPayloadHash, metadataHash };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidSnapshotMetadata(
  value: unknown,
  seasonCode: string,
  now: Date,
): value is PriceChangeHotSnapshotMetadata {
  if (!isRecord(value)) return false;
  const expectedPlayerCount = value.expectedPlayerCount;
  const observedPlayerCount = value.observedPlayerCount;
  const corePlayerCount = value.corePlayerCount;
  const corePlayerDelta = value.corePlayerDelta;
  if (
    (value.schemaVersion !== 3 && value.schemaVersion !== PRICE_CHANGE_HOT_SCHEMA_VERSION) ||
    value.seasonCode !== seasonCode ||
    typeof value.revision !== 'string' ||
    !/^[0-9a-f]{16}$/.test(value.revision) ||
    typeof value.triggerFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.triggerFingerprint) ||
    typeof value.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sourceHash) ||
    typeof value.payloadHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.payloadHash) ||
    typeof value.metadataHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.metadataHash) ||
    (value.artifactId !== null && typeof value.artifactId !== 'string') ||
    (value.deadline !== null &&
      (typeof value.deadline !== 'string' || !Number.isFinite(Date.parse(value.deadline)))) ||
    !Array.isArray(value.nextDeadlines) ||
    value.nextDeadlines.length === 0 ||
    !value.nextDeadlines.every(
      (deadline): deadline is string =>
        typeof deadline === 'string' && Number.isFinite(Date.parse(deadline)),
    ) ||
    value.deadline !== value.nextDeadlines[0] ||
    typeof value.detectedAt !== 'string' ||
    typeof value.fetchedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof expectedPlayerCount !== 'number' ||
    !Number.isSafeInteger(expectedPlayerCount) ||
    typeof observedPlayerCount !== 'number' ||
    !Number.isSafeInteger(observedPlayerCount) ||
    expectedPlayerCount <= 0 ||
    observedPlayerCount <= 0 ||
    expectedPlayerCount !== observedPlayerCount ||
    (corePlayerCount !== null &&
      (typeof corePlayerCount !== 'number' || !Number.isSafeInteger(corePlayerCount))) ||
    (corePlayerDelta !== null &&
      (typeof corePlayerDelta !== 'number' || !Number.isSafeInteger(corePlayerDelta))) ||
    !isRecord(value.reconciliation)
  ) {
    return false;
  }
  for (let index = 1; index < value.nextDeadlines.length; index += 1) {
    if (Date.parse(value.nextDeadlines[index - 1]!) >= Date.parse(value.nextDeadlines[index]!)) {
      return false;
    }
  }
  const detectedAt = Date.parse(value.detectedAt);
  const fetchedAt = Date.parse(value.fetchedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(detectedAt) ||
    !Number.isFinite(fetchedAt) ||
    !Number.isFinite(expiresAt) ||
    detectedAt > now.getTime() ||
    fetchedAt > now.getTime() ||
    expiresAt <= now.getTime() ||
    expiresAt !== detectedAt + PRICE_CHANGE_HOT_TTL_MS
  ) {
    return false;
  }
  const reconciliation = value.reconciliation;
  if (
    !['pending', 'reconciled', 'failed'].includes(String(reconciliation.state)) ||
    (reconciliation.durablePublicationId !== null &&
      typeof reconciliation.durablePublicationId !== 'string') ||
    (reconciliation.durableRevision !== null &&
      !Number.isSafeInteger(reconciliation.durableRevision)) ||
    (reconciliation.error !== null && typeof reconciliation.error !== 'string')
  ) {
    return false;
  }
  if (
    reconciliation.state === 'pending' &&
    (reconciliation.durablePublicationId !== null || reconciliation.durableRevision !== null)
  ) {
    return false;
  }
  if (
    reconciliation.state === 'reconciled' &&
    (reconciliation.durablePublicationId === null ||
      reconciliation.durableRevision === null ||
      !DURABLE_PUBLICATION_ID_PATTERN.test(reconciliation.durablePublicationId) ||
      typeof reconciliation.durableRevision !== 'number' ||
      reconciliation.durableRevision <= 0 ||
      reconciliation.error !== null)
  ) {
    return false;
  }
  if (
    reconciliation.state === 'failed' &&
    (reconciliation.error === null ||
      reconciliation.durablePublicationId !== null ||
      reconciliation.durableRevision !== null)
  ) {
    return false;
  }
  return hotMetadataHash(value) === value.metadataHash;
}

function isValidSnapshot(
  value: unknown,
  seasonCode: string,
  now: Date,
): value is PriceChangeHotSnapshot {
  if (!isValidSnapshotMetadata(value, seasonCode, now)) return false;
  const snapshot = value as PriceChangeHotSnapshot;
  if (hotPayloadHash(snapshot) !== snapshot.payloadHash) return false;
  if (!isRecord(snapshot.board)) return false;
  const expectedPlayerCount = snapshot.expectedPlayerCount;
  const observedPlayerCount = snapshot.observedPlayerCount;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (
    expectedPlayerCount !== observedPlayerCount ||
    expectedPlayerCount <= 0 ||
    observedPlayerCount <= 0 ||
    expectedPlayerCount !== snapshot.board.expectedPlayerCount ||
    observedPlayerCount !== snapshot.board.observedPlayerCount ||
    snapshot.board.deadline !== snapshot.deadline ||
    !Array.isArray(snapshot.board.nextDeadlines) ||
    snapshot.board.nextDeadlines.length !== snapshot.nextDeadlines.length ||
    snapshot.board.nextDeadlines.some(
      (deadline, index) => deadline !== snapshot.nextDeadlines[index],
    ) ||
    !Array.isArray(snapshot.board.players) ||
    snapshot.board.players.length !== observedPlayerCount ||
    snapshot.board.revision !== snapshot.revision ||
    !['READY', 'STALE'].includes(String(snapshot.board.status)) ||
    typeof snapshot.board.fetchedAt !== 'string' ||
    typeof snapshot.board.staleAt !== 'string' ||
    snapshot.board.source !== 'FPL_BOOTSTRAP'
  ) {
    return false;
  }
  const boardFetchedAt = Date.parse(snapshot.board.fetchedAt);
  const boardStaleAt = Date.parse(snapshot.board.staleAt);
  if (
    !Number.isFinite(boardFetchedAt) ||
    !Number.isFinite(boardStaleAt) ||
    boardFetchedAt !== fetchedAt ||
    boardStaleAt !== fetchedAt + PRICE_CHANGE_READY_MS
  ) {
    return false;
  }
  const boardRecord = snapshot.board as unknown as Record<string, unknown>;
  if (
    snapshot.schemaVersion === PRICE_CHANGE_HOT_SCHEMA_VERSION &&
    !('latestEvent' in boardRecord)
  ) {
    return false;
  }
  if (snapshot.board.latestEvent) {
    try {
      validatePriceChangeObservedEvent(snapshot.board.latestEvent, snapshot.board.players, {
        requireCurrentPriceMatch: true,
      });
    } catch {
      return false;
    }
    if (Date.parse(snapshot.board.latestEvent.observedAt) > fetchedAt) return false;
  }
  return true;
}

function parsePointer(value: string | null): {
  readonly revision: string;
  readonly payloadKey: string;
  readonly detectedAtMs: number;
  readonly payloadHash: string;
  readonly metadataHash: string;
} | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.revision !== 'string' ||
      typeof parsed.payloadKey !== 'string' ||
      !Number.isSafeInteger(parsed.detectedAtMs) ||
      typeof parsed.payloadHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.payloadHash) ||
      typeof parsed.metadataHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.metadataHash)
    ) {
      return null;
    }
    return {
      revision: parsed.revision,
      payloadKey: parsed.payloadKey,
      detectedAtMs: Number(parsed.detectedAtMs),
      payloadHash: parsed.payloadHash,
      metadataHash: parsed.metadataHash,
    };
  } catch {
    return null;
  }
}

const POINTER_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, parsed = pcall(cjson.decode, current)
  if ok and parsed and parsed.detectedAtMs and tonumber(parsed.detectedAtMs) >= tonumber(ARGV[3]) then
    return 0
  end
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[4])
redis.call('SET', KEYS[3], ARGV[5], 'PX', ARGV[4])
redis.call('SADD', KEYS[4], KEYS[2])
redis.call('PEXPIRE', KEYS[4], ARGV[4])
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[4])
return 1
`;

export async function publishPriceChangeHotSnapshot(
  snapshot: PriceChangeHotSnapshot,
): Promise<{ readonly published: boolean; readonly payloadKey: string }> {
  const redis = await redisSingleton.getClient();
  const payloadKey = priceChangeHotPayloadKey(
    snapshot.seasonCode,
    snapshot.revision,
    snapshot.sourceHash,
  );
  const metadataKey = priceChangeHotMetadataKey(
    snapshot.seasonCode,
    snapshot.revision,
    snapshot.sourceHash,
  );
  const pointerKey = priceChangeHotPointerKey(snapshot.seasonCode);
  const revisionIndexKey = priceChangeHotRevisionIndexKey(snapshot.seasonCode, snapshot.revision);
  const payload = JSON.stringify(snapshot);
  const pointer = JSON.stringify({
    revision: snapshot.revision,
    payloadKey,
    detectedAtMs: Date.parse(snapshot.detectedAt),
    payloadHash: snapshot.payloadHash,
    metadataHash: snapshot.metadataHash,
  });
  const result = await redis.eval(
    POINTER_CAS_SCRIPT,
    4,
    pointerKey,
    payloadKey,
    metadataKey,
    revisionIndexKey,
    payload,
    pointer,
    Date.parse(snapshot.detectedAt),
    PRICE_CHANGE_HOT_TTL_MS,
    priceChangeHotSnapshotMetadata(snapshot),
  );
  return { published: Number(result) === 1, payloadKey };
}

export async function readPriceChangeHotSnapshot(
  seasonCode: string,
  now = new Date(),
): Promise<PriceChangeHotSnapshot | null> {
  const redis = await redisSingleton.getClient();
  const pointer = parsePointer(await redis.get(priceChangeHotPointerKey(seasonCode)));
  if (!pointer) return null;
  const snapshot = await readPriceChangeHotSnapshotPayload(
    redis,
    seasonCode,
    pointer.payloadKey,
    pointer.revision,
    now,
    pointer.payloadHash,
  );
  if (
    !snapshot ||
    pointer.payloadKey !==
      priceChangeHotPayloadKey(seasonCode, snapshot.revision, snapshot.sourceHash)
  ) {
    return null;
  }
  return snapshot;
}

/**
 * Read one immutable hot payload by revision, without consulting the active
 * pointer. Reconciliation jobs use this when a newer hot board has already
 * become active so the archived source keeps its original capture time.
 */
export async function readPriceChangeHotSnapshotAtRevision(
  seasonCode: string,
  revision: string,
  sourceHashOrNow?: string | Date,
  now = new Date(),
  projectStatus = true,
): Promise<PriceChangeHotSnapshot | null> {
  if (!/^[0-9a-f]{16}$/.test(revision)) return null;
  const sourceHash = sourceHashOrNow instanceof Date ? undefined : sourceHashOrNow;
  const readAt = sourceHashOrNow instanceof Date ? sourceHashOrNow : now;
  const redis = await redisSingleton.getClient();
  if (sourceHash !== undefined && !/^[0-9a-f]{64}$/.test(sourceHash)) return null;
  const payloadKeys = sourceHash
    ? [priceChangeHotPayloadKey(seasonCode, revision, sourceHash)]
    : await redis.smembers(priceChangeHotRevisionIndexKey(seasonCode, revision));
  for (const payloadKey of payloadKeys) {
    const snapshot = await readPriceChangeHotSnapshotPayload(
      redis,
      seasonCode,
      payloadKey,
      revision,
      readAt,
      undefined,
      projectStatus,
    );
    if (
      snapshot &&
      payloadKey === priceChangeHotPayloadKey(seasonCode, snapshot.revision, snapshot.sourceHash)
    ) {
      return snapshot;
    }
  }
  return null;
}

/**
 * Read only the active immutable hot metadata envelope. Status and cursor
 * consumers must not transfer or parse the player-filled board on every
 * health poll; the full payload is reserved for an explicit reconciliation or
 * revision-bound board read.
 */
export async function readPriceChangeHotSnapshotMetadata(
  seasonCode: string,
  now = new Date(),
): Promise<PriceChangeHotSnapshotMetadata | null> {
  const redis = await redisSingleton.getClient();
  const pointer = parsePointer(await redis.get(priceChangeHotPointerKey(seasonCode)));
  if (!pointer) return null;
  const raw = await redis.get(`${pointer.payloadKey}:metadata`);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isValidSnapshotMetadata(parsed, seasonCode, now)) return null;
  if (
    parsed.revision !== pointer.revision ||
    parsed.payloadHash !== pointer.payloadHash ||
    parsed.metadataHash !== pointer.metadataHash ||
    pointer.payloadKey !== priceChangeHotPayloadKey(seasonCode, parsed.revision, parsed.sourceHash)
  ) {
    return null;
  }
  return parsed;
}

async function readPriceChangeHotSnapshotPayload(
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
  seasonCode: string,
  payloadKey: string,
  expectedRevision: string,
  now: Date,
  expectedPayloadHash?: string,
  projectStatus = true,
): Promise<PriceChangeHotSnapshot | null> {
  const raw = await redis.get(payloadKey);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (
    !isValidSnapshot(parsed, seasonCode, now) ||
    parsed.revision !== expectedRevision ||
    (expectedPayloadHash !== undefined && parsed.payloadHash !== expectedPayloadHash)
  )
    return null;
  const ageMs = now.getTime() - Date.parse(parsed.fetchedAt);
  return {
    ...parsed,
    board: projectStatus
      ? {
          ...parsed.board,
          status: ageMs < PRICE_CHANGE_READY_MS ? 'READY' : 'STALE',
        }
      : parsed.board,
  };
}

export async function readPriceChangeHotCursor(
  seasonCode: string,
  now = new Date(),
): Promise<PriceChangeHotCursor | null> {
  const metadata = await readPriceChangeHotSnapshotMetadata(seasonCode, now);
  if (!metadata) return null;
  return {
    seasonCode,
    revision: metadata.revision,
    detectedAt: metadata.detectedAt,
    fetchedAt: metadata.fetchedAt,
    expiresAt: metadata.expiresAt,
    state:
      metadata.reconciliation.state === 'failed'
        ? 'FAILED'
        : metadata.reconciliation.state === 'reconciled'
          ? 'RECONCILED'
          : now.getTime() - Date.parse(metadata.fetchedAt) >= PRICE_CHANGE_READY_MS
            ? 'STALE'
            : 'PROVISIONAL',
    reconciliationError: metadata.reconciliation.error,
  };
}

export async function markPriceChangeHotReconciliation(
  snapshot: PriceChangeHotSnapshot,
  input:
    | {
        readonly state: 'pending';
        readonly error: string;
      }
    | {
        readonly state: 'reconciled';
        readonly durablePublicationId: string;
        readonly durableRevision: number;
      }
    | { readonly state: 'failed'; readonly error: unknown },
): Promise<boolean> {
  const current = await readPriceChangeHotSnapshotAtRevision(
    snapshot.seasonCode,
    snapshot.revision,
    snapshot.sourceHash,
    new Date(),
    false,
  );
  if (!current || current.sourceHash !== snapshot.sourceHash) return false;
  // Keep a verified durable publication terminal. A worker can fail after
  // writing the reconciled marker (for example while completing its lane),
  // and a later Bull terminal callback must not turn that success into a
  // misleading failed state.
  if (input.state !== 'reconciled' && current.reconciliation.state === 'reconciled') {
    return true;
  }
  const persistedError = input.state === 'reconciled' ? '' : formatPriceChangeHotError(input.error);
  const failureError =
    input.state === 'reconciled'
      ? ''
      : input.state === 'failed' && current.reconciliation.error
        ? `${current.reconciliation.error}; ${persistedError}`
        : persistedError;
  const updated: PriceChangeHotSnapshot = {
    ...current,
    reconciliation:
      input.state === 'reconciled'
        ? {
            state: 'reconciled',
            durablePublicationId: input.durablePublicationId,
            durableRevision: input.durableRevision,
            error: null,
          }
        : {
            state: input.state,
            durablePublicationId: null,
            durableRevision: null,
            error: failureError.slice(0, 1_000),
          },
  };
  const redis = await redisSingleton.getClient();
  const result = await redis.eval(
    `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, existing = pcall(cjson.decode, raw)
if not ok or not existing then return 0 end
if existing.revision ~= ARGV[1] or existing.sourceHash ~= ARGV[2] then return 0 end
if ARGV[4] ~= 'reconciled' and existing.reconciliation and existing.reconciliation.state == 'reconciled' then
  return 1
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[5])
redis.call('SET', KEYS[2], ARGV[6], 'PX', ARGV[5])
return 1
`,
    2,
    priceChangeHotPayloadKey(updated.seasonCode, updated.revision, updated.sourceHash),
    priceChangeHotMetadataKey(updated.seasonCode, updated.revision, updated.sourceHash),
    updated.revision,
    updated.sourceHash,
    JSON.stringify(updated),
    input.state,
    Math.max(Date.parse(updated.expiresAt) - Date.now(), 1),
    priceChangeHotSnapshotMetadata(updated),
  );
  return Number(result) === 1;
}
