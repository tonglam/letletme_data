import { createHash, randomUUID } from 'node:crypto';

import {
  BootstrapResponseSchema,
  type FPLBootstrapArtifactResponse,
  type FPLBootstrapResponse,
} from '../clients/fpl';
import {
  normalizePriceChangeBoard,
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
  state: 'PROVISIONAL';
}>;

export function priceChangeHotPointerKey(seasonCode: string): string {
  return `${HOT_KEY_PREFIX}:${seasonCode}:active`;
}

export function priceChangeHotPayloadKey(seasonCode: string, revision: string): string {
  return `${HOT_KEY_PREFIX}:${seasonCode}:${revision}`;
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
    value.board.status !== 'READY' ||
    value.board.source !== 'FPL_BOOTSTRAP'
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
  if ok and parsed and parsed.detectedAtMs and tonumber(parsed.detectedAtMs) >= tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
return 1
`;

export async function publishPriceChangeHotSnapshot(
  snapshot: PriceChangeHotSnapshot,
): Promise<{ readonly published: boolean; readonly payloadKey: string }> {
  const redis = await redisSingleton.getClient();
  const payloadKey = priceChangeHotPayloadKey(snapshot.seasonCode, snapshot.revision);
  const pointerKey = priceChangeHotPointerKey(snapshot.seasonCode);
  const payload = JSON.stringify(snapshot);
  const pointer = JSON.stringify({
    revision: snapshot.revision,
    payloadKey,
    detectedAtMs: Date.parse(snapshot.detectedAt),
  });
  await redis.set(payloadKey, payload, 'PX', PRICE_CHANGE_HOT_TTL_MS);
  const result = await redis.eval(
    POINTER_CAS_SCRIPT,
    1,
    pointerKey,
    pointer,
    Date.parse(snapshot.detectedAt),
    PRICE_CHANGE_HOT_TTL_MS,
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
  const raw = await redis.get(pointer.payloadKey);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isValidSnapshot(parsed, seasonCode, now) || parsed.revision !== pointer.revision)
    return null;
  return parsed;
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
    state: 'PROVISIONAL',
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
  const current = await readPriceChangeHotSnapshot(snapshot.seasonCode);
  if (!current || current.revision !== snapshot.revision) return false;
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
  await redis.set(
    priceChangeHotPayloadKey(updated.seasonCode, updated.revision),
    JSON.stringify(updated),
    'PX',
    Math.max(Date.parse(updated.expiresAt) - Date.now(), 1),
  );
  return true;
}
