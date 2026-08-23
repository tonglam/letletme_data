import { createHash } from 'node:crypto';

export const MANAGER_LIVE_HOT_SCOPE_SECONDS = 6 * 60 * 60;
export const MANAGER_LIVE_REFRESH_BUCKET_MS = 30_000;
export const MANAGER_LIVE_ATTEMPTS = 4;
export const MANAGER_LIVE_RETRY_BASE_DELAY_MS = 30_000;

export type ManagerLiveRefreshScope = {
  seasonId: number;
  seasonCode: string;
  eventId: number;
  entryIds: number[];
  tournamentId?: number;
};

type ManagerLiveHotRedis = {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

export const normalizeManagerLiveEntryIds = (entryIds: readonly number[]): number[] =>
  Array.from(new Set(entryIds)).sort((left, right) => left - right);

const entrySetDigest = (entryIds: readonly number[]): string =>
  createHash('sha1')
    .update(normalizeManagerLiveEntryIds(entryIds).join(','))
    .digest('hex')
    .slice(0, 12);

const scopeSegment = (scope: Pick<ManagerLiveRefreshScope, 'entryIds' | 'tournamentId'>): string =>
  scope.tournamentId === undefined
    ? `entries-${entrySetDigest(scope.entryIds)}`
    : `t${scope.tournamentId}`;

export const managerLiveHotScopeKey = (scope: ManagerLiveRefreshScope): string =>
  `llm:queue:manager-live:hot:v1:${scope.seasonCode}:e${scope.eventId}:${scopeSegment(scope)}`;

export function managerLiveRefreshBucket(date: Date): string {
  const bucket = new Date(
    Math.floor(date.getTime() / MANAGER_LIVE_REFRESH_BUCKET_MS) * MANAGER_LIVE_REFRESH_BUCKET_MS,
  );
  return bucket.toISOString().replace(/\D/g, '').slice(0, 14);
}

export function managerLiveRefreshJobId(scope: ManagerLiveRefreshScope, date: Date): string {
  return `manager-live-v1-${scope.seasonCode}-e${scope.eventId}-${scopeSegment(scope)}-${managerLiveRefreshBucket(date)}`;
}

export const parseManagerLiveHotScope = (value: string | null): ManagerLiveRefreshScope | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ManagerLiveRefreshScope>;
    const entryIds = Array.isArray(parsed.entryIds)
      ? normalizeManagerLiveEntryIds(parsed.entryIds)
      : [];
    if (
      !Number.isSafeInteger(parsed.seasonId) ||
      typeof parsed.seasonCode !== 'string' ||
      !/^\d{4}$/.test(parsed.seasonCode) ||
      !Number.isSafeInteger(parsed.eventId) ||
      (parsed.eventId ?? 0) <= 0 ||
      entryIds.length === 0 ||
      entryIds.length > 500 ||
      entryIds.some((entryId) => !Number.isSafeInteger(entryId) || entryId <= 0) ||
      (parsed.tournamentId !== undefined &&
        (!Number.isSafeInteger(parsed.tournamentId) || parsed.tournamentId <= 0))
    ) {
      return null;
    }
    return {
      seasonId: parsed.seasonId,
      seasonCode: parsed.seasonCode,
      eventId: parsed.eventId,
      entryIds,
      ...(parsed.tournamentId === undefined ? {} : { tournamentId: parsed.tournamentId }),
    } as ManagerLiveRefreshScope;
  } catch {
    return null;
  }
};

export const shouldStopManagerLiveRefresh = (event: {
  finished: boolean;
  dataChecked: boolean;
}): boolean => event.finished && event.dataChecked;

export async function writeManagerLiveHotScope(
  redis: ManagerLiveHotRedis,
  scope: ManagerLiveRefreshScope,
): Promise<void> {
  await redis.set(
    managerLiveHotScopeKey(scope),
    JSON.stringify({ ...scope, entryIds: normalizeManagerLiveEntryIds(scope.entryIds) }),
    'EX',
    MANAGER_LIVE_HOT_SCOPE_SECONDS,
  );
}

export async function loadManagerLiveHotScope(
  redis: ManagerLiveHotRedis,
  scope: ManagerLiveRefreshScope,
): Promise<ManagerLiveRefreshScope | null> {
  return parseManagerLiveHotScope(await redis.get(managerLiveHotScopeKey(scope)));
}
