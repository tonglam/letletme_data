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
  type PriceChangeBoard,
} from './price-change-predictions.service';
import type { FplSeasonRef } from '../domain/fpl-season';
import { redisSingleton } from '../cache/singleton';
import { getConfig } from '../utils/config';
import { logInfo } from '../utils/logger';
import { createFplSourceArtifactStorage } from './fpl-source-artifact-storage.service';

export const PRICE_CHANGE_HOT_TTL_MS = 15 * 60 * 1000;
export const PRICE_CHANGE_HOT_SCHEMA_VERSION = 1 as const;

const HOT_KEY_PREFIX = 'fpl:price-changes:hot';

export type PriceChangeHotReconciliationState = 'pending' | 'reconciled' | 'failed';

export type PriceChangeHotSnapshot = Readonly<{
  schemaVersion: typeof PRICE_CHANGE_HOT_SCHEMA_VERSION;
  seasonCode: string;
  revision: string;
  triggerFingerprint: string;
  sourceHash: string;
  artifactId: string | null;
  deadline: string | null;
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

export function priceChangeHotPayloadKey(seasonCode: string, revision: string): string {
  return `${HOT_KEY_PREFIX}:${seasonCode}:${revision}`;
}

/** Small metadata envelope used by cursor polling without loading the board. */
export function priceChangeHotMetadataKey(seasonCode: string, revision: string): string {
  return `${HOT_KEY_PREFIX}:${seasonCode}:${revision}:metadata`;
}

type PriceChangeHotSnapshotMetadata = Omit<PriceChangeHotSnapshot, 'board'>;

function priceChangeHotSnapshotMetadata(snapshot: PriceChangeHotSnapshot): string {
  const metadata: PriceChangeHotSnapshotMetadata = {
    schemaVersion: snapshot.schemaVersion,
    seasonCode: snapshot.seasonCode,
    revision: snapshot.revision,
    triggerFingerprint: snapshot.triggerFingerprint,
    sourceHash: snapshot.sourceHash,
    artifactId: snapshot.artifactId,
    deadline: snapshot.deadline,
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
}): PriceChangeHotSnapshot {
  const detectedAt = input.detectedAt ?? new Date();
  const fetchedAt = input.fetchedAt ?? detectedAt;
  if (!Number.isFinite(detectedAt.getTime()) || !Number.isFinite(fetchedAt.getTime())) {
    throw new Error('Price-change hot snapshot timestamps are invalid');
  }
  const board = normalizePriceChangeBoard(input.bootstrap, fetchedAt);
  const expiresAt = new Date(detectedAt.getTime() + PRICE_CHANGE_HOT_TTL_MS);
  return {
    schemaVersion: PRICE_CHANGE_HOT_SCHEMA_VERSION,
    seasonCode: input.season.seasonCode,
    revision: board.revision,
    triggerFingerprint: priceChangeTriggerFingerprint(input.bootstrap),
    sourceHash: input.sourceHash,
    artifactId: input.artifactId ?? null,
    deadline: board.deadline,
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidSnapshot(
  value: unknown,
  seasonCode: string,
  now: Date,
): value is PriceChangeHotSnapshot {
  if (!isRecord(value)) return false;
  const expectedPlayerCount = value.expectedPlayerCount;
  const observedPlayerCount = value.observedPlayerCount;
  const corePlayerCount = value.corePlayerCount;
  const corePlayerDelta = value.corePlayerDelta;
  if (
    value.schemaVersion !== PRICE_CHANGE_HOT_SCHEMA_VERSION ||
    value.seasonCode !== seasonCode ||
    typeof value.revision !== 'string' ||
    !/^[0-9a-f]{16}$/.test(value.revision) ||
    typeof value.triggerFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.triggerFingerprint) ||
    typeof value.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sourceHash) ||
    (value.artifactId !== null && typeof value.artifactId !== 'string') ||
    (value.deadline !== null && typeof value.deadline !== 'string') ||
    typeof value.detectedAt !== 'string' ||
    typeof value.fetchedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof expectedPlayerCount !== 'number' ||
    !Number.isSafeInteger(expectedPlayerCount) ||
    typeof observedPlayerCount !== 'number' ||
    !Number.isSafeInteger(observedPlayerCount) ||
    (corePlayerCount !== null &&
      (typeof corePlayerCount !== 'number' || !Number.isSafeInteger(corePlayerCount))) ||
    (corePlayerDelta !== null &&
      (typeof corePlayerDelta !== 'number' || !Number.isSafeInteger(corePlayerDelta))) ||
    !isRecord(value.board) ||
    !isRecord(value.reconciliation)
  ) {
    return false;
  }
  const detectedAt = Date.parse(value.detectedAt);
  const fetchedAt = Date.parse(value.fetchedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(detectedAt) || !Number.isFinite(fetchedAt) || !Number.isFinite(expiresAt)) {
    return false;
  }
  if (expiresAt <= now.getTime() || expiresAt !== detectedAt + PRICE_CHANGE_HOT_TTL_MS) {
    return false;
  }
  if (
    expectedPlayerCount !== observedPlayerCount ||
    expectedPlayerCount <= 0 ||
    observedPlayerCount <= 0 ||
    expectedPlayerCount !== value.board.expectedPlayerCount ||
    observedPlayerCount !== value.board.observedPlayerCount ||
    value.board.deadline !== value.deadline ||
    !Array.isArray(value.board.nextDeadlines) ||
    !Array.isArray(value.board.players) ||
    value.board.players.length !== observedPlayerCount ||
    value.board.revision !== value.revision ||
    !['READY', 'STALE'].includes(String(value.board.status)) ||
    typeof value.board.fetchedAt !== 'string' ||
    typeof value.board.staleAt !== 'string' ||
    value.board.source !== 'FPL_BOOTSTRAP'
  ) {
    return false;
  }
  const boardFetchedAt = Date.parse(value.board.fetchedAt);
  const boardStaleAt = Date.parse(value.board.staleAt);
  if (
    !Number.isFinite(boardFetchedAt) ||
    !Number.isFinite(boardStaleAt) ||
    boardFetchedAt !== fetchedAt ||
    boardStaleAt !== fetchedAt + PRICE_CHANGE_READY_MS
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
  return true;
}

function parsePointer(value: string | null): {
  readonly revision: string;
  readonly payloadKey: string;
  readonly detectedAtMs: number;
} | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.revision !== 'string' ||
      typeof parsed.payloadKey !== 'string' ||
      !Number.isSafeInteger(parsed.detectedAtMs)
    ) {
      return null;
    }
    return {
      revision: parsed.revision,
      payloadKey: parsed.payloadKey,
      detectedAtMs: Number(parsed.detectedAtMs),
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
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[4])
return 1
`;

export async function publishPriceChangeHotSnapshot(
  snapshot: PriceChangeHotSnapshot,
): Promise<{ readonly published: boolean; readonly payloadKey: string }> {
  const redis = await redisSingleton.getClient();
  const payloadKey = priceChangeHotPayloadKey(snapshot.seasonCode, snapshot.revision);
  const metadataKey = priceChangeHotMetadataKey(snapshot.seasonCode, snapshot.revision);
  const pointerKey = priceChangeHotPointerKey(snapshot.seasonCode);
  const payload = JSON.stringify(snapshot);
  const pointer = JSON.stringify({
    revision: snapshot.revision,
    payloadKey,
    detectedAtMs: Date.parse(snapshot.detectedAt),
  });
  const result = await redis.eval(
    POINTER_CAS_SCRIPT,
    3,
    pointerKey,
    payloadKey,
    metadataKey,
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
  if (pointer.payloadKey !== priceChangeHotPayloadKey(seasonCode, pointer.revision)) return null;
  return readPriceChangeHotSnapshotPayload(
    redis,
    seasonCode,
    pointer.payloadKey,
    pointer.revision,
    now,
  );
}

/**
 * Read one immutable hot payload by revision, without consulting the active
 * pointer. Reconciliation jobs use this when a newer hot board has already
 * become active so the archived source keeps its original capture time.
 */
export async function readPriceChangeHotSnapshotAtRevision(
  seasonCode: string,
  revision: string,
  now = new Date(),
): Promise<PriceChangeHotSnapshot | null> {
  if (!/^[0-9a-f]{16}$/.test(revision)) return null;
  const redis = await redisSingleton.getClient();
  return readPriceChangeHotSnapshotPayload(
    redis,
    seasonCode,
    priceChangeHotPayloadKey(seasonCode, revision),
    revision,
    now,
  );
}

async function readPriceChangeHotSnapshotPayload(
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
  seasonCode: string,
  payloadKey: string,
  expectedRevision: string,
  now: Date,
): Promise<PriceChangeHotSnapshot | null> {
  const raw = await redis.get(payloadKey);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isValidSnapshot(parsed, seasonCode, now) || parsed.revision !== expectedRevision)
    return null;
  const ageMs = now.getTime() - Date.parse(parsed.fetchedAt);
  return {
    ...parsed,
    board: {
      ...parsed.board,
      status: ageMs < PRICE_CHANGE_READY_MS ? 'READY' : 'STALE',
    },
  };
}

export async function readPriceChangeHotCursor(
  seasonCode: string,
  now = new Date(),
): Promise<PriceChangeHotCursor | null> {
  const snapshot = await readPriceChangeHotSnapshot(seasonCode, now);
  if (!snapshot) return null;
  return {
    seasonCode,
    revision: snapshot.revision,
    detectedAt: snapshot.detectedAt,
    fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.expiresAt,
    state:
      snapshot.reconciliation.state === 'failed'
        ? 'FAILED'
        : snapshot.reconciliation.state === 'reconciled'
          ? 'RECONCILED'
          : Date.now() - Date.parse(snapshot.fetchedAt) >= PRICE_CHANGE_READY_MS
            ? 'STALE'
            : 'PROVISIONAL',
    reconciliationError: snapshot.reconciliation.error,
  };
}

export async function markPriceChangeHotReconciliation(
  snapshot: PriceChangeHotSnapshot,
  input:
    | {
        readonly state: 'reconciled';
        readonly durablePublicationId: string;
        readonly durableRevision: number;
      }
    | { readonly state: 'failed'; readonly error: string },
): Promise<boolean> {
  const current = await readPriceChangeHotSnapshotAtRevision(
    snapshot.seasonCode,
    snapshot.revision,
  );
  if (!current || current.sourceHash !== snapshot.sourceHash) return false;
  // Keep a verified durable publication terminal. A worker can fail after
  // writing the reconciled marker (for example while completing its lane),
  // and a later Bull terminal callback must not turn that success into a
  // misleading failed state.
  if (input.state === 'failed' && current.reconciliation.state === 'reconciled') {
    return true;
  }
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
            state: 'failed',
            durablePublicationId: null,
            durableRevision: null,
            error: input.error.slice(0, 1_000),
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
if ARGV[4] == 'failed' and existing.reconciliation and existing.reconciliation.state == 'reconciled' then
  return 1
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[5])
redis.call('SET', KEYS[2], ARGV[6], 'PX', ARGV[5])
return 1
`,
    2,
    priceChangeHotPayloadKey(updated.seasonCode, updated.revision),
    priceChangeHotMetadataKey(updated.seasonCode, updated.revision),
    updated.revision,
    updated.sourceHash,
    JSON.stringify(updated),
    input.state,
    Math.max(Date.parse(updated.expiresAt) - Date.now(), 1),
    priceChangeHotSnapshotMetadata(updated),
  );
  return Number(result) === 1;
}
