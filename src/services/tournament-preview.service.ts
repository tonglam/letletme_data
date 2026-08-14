import { createHash, randomBytes } from 'node:crypto';

import { parseLeagueUrl, type LeagueType, type TournamentParticipant } from '../domain/tournament';
import { seasonRepository } from '../repositories/seasons';
import { ConflictError, ValidationError } from '../utils/errors';
import { logInfo } from '../utils/logger';
import { queueRedisSingleton } from '../queues/redis';
import { fetchLeagueParticipantsById } from './tournament-league-members.service';

const PREVIEW_TTL_SECONDS = 5 * 60;
const previewInflight = new Map<string, Promise<TournamentPreview>>();

type PreviewStored = {
  tokenHash: string;
  ownerEntryId: number;
  seasonCode: string;
  leagueId: number;
  leagueType: LeagueType;
  leagueName: string | null;
  startEventId: number;
  knockoutRounds: number;
  participants: TournamentParticipant[];
  sourceCheckedAt: string;
  expiresAt: string;
};

export type TournamentPreview = Omit<PreviewStored, 'tokenHash'> & {
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

function normalizeOwnerEntry(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  throw new ValidationError(
    'A valid verified Entry is required.',
    'TOURNAMENT_PREVIEW_ENTRY_INVALID',
  );
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
  if (inflight) return inflight;

  const promise = (async () => {
    const redis = await queueRedisSingleton.getClient();
    const existingTokenHash = await redis.get(key);
    if (existingTokenHash) {
      const existing = await redis.get(tokenKey(existingTokenHash));
      if (existing) {
        const parsed = JSON.parse(existing) as PreviewStored;
        // The raw token is intentionally never persisted. Reissue an opaque
        // token while reusing the already fetched participant snapshot.
        const previewToken = randomBytes(32).toString('base64url');
        const tokenHash = hashToken(previewToken);
        const refreshed = {
          ...parsed,
          tokenHash,
          expiresAt: new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString(),
        };
        await redis.set(tokenKey(tokenHash), JSON.stringify(refreshed), 'EX', PREVIEW_TTL_SECONDS);
        await redis.set(key, tokenHash, 'EX', PREVIEW_TTL_SECONDS);
        // Do not revoke the older token. Its caller may still be within the
        // advertised five-minute lifetime; both payloads are independently
        // expiring and remain bound to the same owner/league/season.
        return { ...refreshed, previewToken };
      }
      await redis.del(key);
    }

    const source = await fetchLeagueParticipantsById(leagueId, leagueType);
    const previewToken = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(previewToken);
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_SECONDS * 1000).toISOString();
    const stored: PreviewStored = {
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
    const serialized = JSON.stringify(stored);
    // Keep token and reuse pointer aligned. The pointer is only a convenience;
    // the token payload remains the source of truth and is independently expiring.
    await redis.set(tokenKey(tokenHash), serialized, 'EX', PREVIEW_TTL_SECONDS);
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
): Promise<PreviewStored> {
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
  const stored = JSON.parse(raw) as PreviewStored;
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
