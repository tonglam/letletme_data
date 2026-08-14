import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

import { parseLeagueUrl, type LeagueType, type TournamentParticipant } from '../domain/tournament';
import { seasonRepository } from '../repositories/seasons';
import { ConflictError, ValidationError } from '../utils/errors';
import { logInfo } from '../utils/logger';
import { queueRedisSingleton } from '../queues/redis';
import { fetchLeagueParticipantsById } from './tournament-league-members.service';

const PREVIEW_TTL_SECONDS = 5 * 60;
const previewInflight = new Map<string, Promise<TournamentPreview>>();

// A content-addressed snapshot can be shared by tokens with different
// lifetimes. Set it only when missing, and extend (never shorten) an existing
// expiry atomically so one older token cannot invalidate a newer token.
const UPSERT_SNAPSHOT_SCRIPT = `
local ttl = redis.call('TTL', KEYS[1])
if ttl == -2 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
elseif ttl >= 0 and ttl < tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return ttl
`;

type PreviewStored = {
  tokenHash: string;
  ownerEntryId: number;
  seasonCode: string;
  leagueId: number;
  leagueType: LeagueType;
  leagueName: string | null;
  startEventId: number;
  knockoutRounds: number;
  participants?: TournamentParticipant[];
  participantSnapshotKey?: string;
  sourceCheckedAt: string;
  expiresAt: string;
};

type HydratedPreview = Omit<PreviewStored, 'participants'> & {
  participants: TournamentParticipant[];
};

export type TournamentPreview = Omit<HydratedPreview, 'tokenHash'> & {
  previewToken: string;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenKey(tokenHash: string): string {
  return `llm:tournament:preview:${tokenHash}`;
}

function createdKey(tokenHash: string): string {
  return `llm:tournament:preview:created:${tokenHash}`;
}

function queuedKey(tokenHash: string): string {
  return `llm:tournament:preview:queued:${tokenHash}`;
}

function creationClaimKey(tokenHash: string): string {
  return `llm:tournament:preview:claim:${tokenHash}`;
}

function reuseKey(
  ownerEntryId: number,
  seasonCode: string,
  leagueId: number,
  leagueType: LeagueType,
): string {
  return `llm:tournament:preview:reuse:${seasonCode}:${ownerEntryId}:${leagueType}:${leagueId}`;
}

function participantSnapshotKey(
  preview: Pick<HydratedPreview, 'seasonCode' | 'leagueId' | 'leagueType' | 'participants'>,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        seasonCode: preview.seasonCode,
        leagueId: preview.leagueId,
        leagueType: preview.leagueType,
        participants: preview.participants,
      }),
    )
    .digest('hex');
  return `llm:tournament:preview:snapshot:${digest}`;
}

async function hydratePreview(redis: Redis, raw: PreviewStored): Promise<HydratedPreview | null> {
  if (Array.isArray(raw.participants)) return raw as HydratedPreview;
  if (!raw.participantSnapshotKey) return null;
  const snapshot = await redis.get(raw.participantSnapshotKey);
  if (!snapshot) return null;
  try {
    const participants = JSON.parse(snapshot) as unknown;
    return Array.isArray(participants) ? ({ ...raw, participants } as HydratedPreview) : null;
  } catch {
    return null;
  }
}

async function persistPreviewToken(
  redis: Redis,
  preview: HydratedPreview,
  tokenHash: string,
  ttlSeconds: number,
): Promise<void> {
  const snapshotKey = preview.participantSnapshotKey ?? participantSnapshotKey(preview);
  await redis.eval(
    UPSERT_SNAPSHOT_SCRIPT,
    1,
    snapshotKey,
    JSON.stringify(preview.participants),
    String(Math.max(1, ttlSeconds)),
  );
  const {
    participants: _participants,
    previewToken: _previewToken,
    ...metadata
  } = preview as HydratedPreview & { previewToken?: string };
  await redis.set(
    tokenKey(tokenHash),
    JSON.stringify({ ...metadata, tokenHash, participantSnapshotKey: snapshotKey }),
    'EX',
    ttlSeconds,
  );
}

function normalizeOwnerEntry(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new ValidationError(
    'A valid verified Entry is required.',
    'TOURNAMENT_PREVIEW_ENTRY_INVALID',
  );
}

async function mintPreviewTokenFromPreview(preview: TournamentPreview): Promise<TournamentPreview> {
  const redis = await queueRedisSingleton.getClient();
  const previewToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(previewToken);
  const { previewToken: _originalToken, ...base } = preview;
  const remainingSeconds = Math.ceil((Date.parse(base.expiresAt) - Date.now()) / 1000);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
    throw new ConflictError(
      'Preview expired or invalid. Please preview the league again.',
      'PREVIEW_EXPIRED',
    );
  }
  await persistPreviewToken(
    redis,
    { ...base, tokenHash } as HydratedPreview,
    tokenHash,
    remainingSeconds,
  );
  return { ...base, previewToken };
}

export async function createTournamentPreview(input: {
  leagueUrl: string;
  ownerEntryId: number | string;
}): Promise<TournamentPreview> {
  const ownerEntryId = normalizeOwnerEntry(input.ownerEntryId);
  const { leagueId, leagueType } = parseLeagueUrl(input.leagueUrl);
  const season = await seasonRepository.findCurrent();
  const key = reuseKey(ownerEntryId, season.seasonCode, leagueId, leagueType);
  const inflight = previewInflight.get(key);
  if (inflight) return mintPreviewTokenFromPreview(await inflight);

  const promise = (async () => {
    const redis = await queueRedisSingleton.getClient();
    const existingTokenHash = await redis.get(key);
    if (existingTokenHash) {
      const existing = await redis.get(tokenKey(existingTokenHash));
      if (existing) {
        const parsed = JSON.parse(existing) as PreviewStored;
        const remainingSeconds = Math.ceil((Date.parse(parsed.expiresAt) - Date.now()) / 1000);
        if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
          await redis.del(tokenKey(existingTokenHash), key);
        } else {
          // The raw token is intentionally never persisted. Reissue an opaque
          // token while reusing the already fetched participant snapshot.
          const hydrated = await hydratePreview(redis, parsed);
          if (!hydrated) {
            await redis.del(tokenKey(existingTokenHash), key);
          } else {
            const previewToken = randomBytes(32).toString('base64url');
            const tokenHash = hashToken(previewToken);
            const refreshed = {
              ...hydrated,
              tokenHash,
              // Reuse never extends the original snapshot freshness deadline.
              expiresAt: parsed.expiresAt,
            };
            await persistPreviewToken(redis, refreshed, tokenHash, remainingSeconds);
            await redis.set(key, tokenHash, 'EX', remainingSeconds);
            // Do not revoke the older token. Its caller may still be within the
            // advertised five-minute lifetime; both payloads are independently
            // expiring and remain bound to the same owner/league/season.
            return { ...refreshed, previewToken };
          }
        }
      }
      await redis.del(key);
    }

    const source = await fetchLeagueParticipantsById(leagueId, leagueType);
    const previewToken = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(previewToken);
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString();
    const stored: HydratedPreview = {
      tokenHash,
      ownerEntryId,
      seasonCode: season.seasonCode,
      leagueId: source.leagueId,
      leagueType: source.leagueType,
      leagueName: source.leagueName,
      startEventId: source.startEventId,
      knockoutRounds: source.knockoutRounds,
      participants: source.participants,
      sourceCheckedAt: new Date().toISOString(),
      expiresAt,
    };
    // Keep one immutable participant snapshot per source payload. Each opaque
    // token stores only metadata and a pointer, avoiding a full roster copy.
    await persistPreviewToken(redis, stored as HydratedPreview, tokenHash, PREVIEW_TTL_SECONDS);
    await redis.set(key, tokenHash, 'EX', PREVIEW_TTL_SECONDS);
    logInfo('Tournament preview ready', {
      event: 'tournament_preview',
      outcome: 'ready',
      participantCount: source.participants.length,
      sourceCheckedAt: stored.sourceCheckedAt,
    });
    return { ...stored, previewToken };
  })();
  previewInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    previewInflight.delete(key);
  }
}

export async function resolveTournamentPreview(
  previewToken: string,
  expected: { ownerEntryId: number | string; leagueUrl: string },
): Promise<HydratedPreview> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(previewToken)) {
    throw new ConflictError(
      'Preview expired or invalid. Please preview the league again.',
      'PREVIEW_EXPIRED',
    );
  }
  const ownerEntryId = normalizeOwnerEntry(expected.ownerEntryId);
  const { leagueId, leagueType } = parseLeagueUrl(expected.leagueUrl);
  const tokenHash = hashToken(previewToken);
  const redis = await queueRedisSingleton.getClient();
  const raw = await redis.get(tokenKey(tokenHash));
  if (!raw) {
    throw new ConflictError(
      'Preview expired or invalid. Please preview the league again.',
      'PREVIEW_EXPIRED',
    );
  }
  const stored = await hydratePreview(redis, JSON.parse(raw) as PreviewStored);
  if (!stored) {
    throw new ConflictError(
      'Preview expired or invalid. Please preview the league again.',
      'PREVIEW_EXPIRED',
    );
  }
  if (
    stored.ownerEntryId !== ownerEntryId ||
    stored.seasonCode !== (await seasonRepository.findCurrent()).seasonCode ||
    stored.leagueId !== leagueId ||
    stored.leagueType !== leagueType ||
    Date.parse(stored.expiresAt) <= Date.now()
  ) {
    throw new ConflictError(
      'Preview expired or invalid. Please preview the league again.',
      'PREVIEW_EXPIRED',
    );
  }
  return stored;
}

export async function getPreviewCreatedResult(tokenHash: string): Promise<unknown | null> {
  const redis = await queueRedisSingleton.getClient();
  const raw = await redis.get(createdKey(tokenHash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    await redis.del(createdKey(tokenHash));
    return null;
  }
}

export async function claimPreviewCreation(tokenHash: string): Promise<'claimed' | 'busy'> {
  const redis = await queueRedisSingleton.getClient();
  // NX makes the preview token the single-writer idempotency boundary.
  const claimed = await redis.set(
    creationClaimKey(tokenHash),
    '1',
    'EX',
    PREVIEW_TTL_SECONDS,
    'NX',
  );
  return claimed === 'OK' ? 'claimed' : 'busy';
}

export async function waitForPreviewCreatedResult(
  tokenHash: string,
  timeoutMs = 2_000,
): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await getPreviewCreatedResult(tokenHash);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return getPreviewCreatedResult(tokenHash);
}

export async function releasePreviewCreationClaim(tokenHash: string): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.del(creationClaimKey(tokenHash));
}

export async function markPreviewCreatedResult(tokenHash: string, result: unknown): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.set(createdKey(tokenHash), JSON.stringify(result), 'EX', PREVIEW_TTL_SECONDS);
}

/**
 * Durable-after-enqueue evidence for retries. It is intentionally separate
 * from the final response cache: a retry may recover only after BullMQ has
 * accepted the authoritative setup job.
 */
export async function getPreviewQueuedResult(tokenHash: string): Promise<unknown | null> {
  const redis = await queueRedisSingleton.getClient();
  const raw = await redis.get(queuedKey(tokenHash));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    await redis.del(queuedKey(tokenHash));
    return null;
  }
}

export async function markPreviewQueuedResult(tokenHash: string, result: unknown): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.set(queuedKey(tokenHash), JSON.stringify(result), 'EX', PREVIEW_TTL_SECONDS);
}
