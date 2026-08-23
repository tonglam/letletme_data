import { createHash } from 'node:crypto';

export const MANAGER_LIVE_HOT_SCOPE_SECONDS = 6 * 60 * 60;
export const MANAGER_LIVE_REFRESH_BUCKET_MS = 30_000;
export const MANAGER_LIVE_ATTEMPTS = 4;
export const MANAGER_LIVE_RETRY_BASE_DELAY_MS = 30_000;
// A manager-live job must leave enough time for cache/checkpoint writes before
// the process-wide 30 second graceful-shutdown deadline. Each logical FPL
// request uses this shorter wall-clock budget, and one job processes only the
// bounded number of summary requests/pages below. Remaining entries stay hot
// and continue in a later 30 second bucket.
export const MANAGER_LIVE_WORKER_REQUEST_DEADLINE_MS = 3_000;
export const MANAGER_LIVE_WORKER_ENTRY_CHUNK_SIZE = 12;
export const MANAGER_LIVE_WORKER_SUMMARY_FETCH_LIMIT = MANAGER_LIVE_WORKER_ENTRY_CHUNK_SIZE;
export const MANAGER_LIVE_WORKER_CLASSIC_STANDINGS_PAGE_LIMIT = 2;
export const MANAGER_LIVE_WORKER_CLASSIC_OR_FETCH_LIMIT = 4;

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

// Keep one recurring hot scope for the complete request. The worker service
// itself consumes at most MANAGER_LIVE_WORKER_ENTRY_CHUNK_SIZE summaries per
// run and rotates stale/missing entries on later buckets. Splitting here would
// create hundreds of independently recurring FPL requests for a 500-entry
// tournament.
export const managerLiveDispatchEntryChunks = (entryIds: readonly number[]): number[][] => {
  const normalized = normalizeManagerLiveEntryIds(entryIds);
  return normalized.length === 0 ? [] : [normalized];
};

const entrySetDigest = (entryIds: readonly number[]): string =>
  createHash('sha1')
    .update(normalizeManagerLiveEntryIds(entryIds).join(','))
    .digest('hex')
    .slice(0, 12);

const scopeSegment = (scope: Pick<ManagerLiveRefreshScope, 'entryIds' | 'tournamentId'>): string =>
  scope.tournamentId === undefined
    ? `entries-${entrySetDigest(scope.entryIds)}`
    : `t${scope.tournamentId}-entries-${entrySetDigest(scope.entryIds)}`;

export const managerLiveHotScopeKey = (scope: ManagerLiveRefreshScope): string =>
  `llm:queue:manager-live:hot:v1:${scope.seasonCode}:e${scope.eventId}:${scopeSegment(scope)}`;

export function managerLiveRefreshBucket(date: Date): string {
  const bucket = new Date(
    Math.floor(date.getTime() / MANAGER_LIVE_REFRESH_BUCKET_MS) * MANAGER_LIVE_REFRESH_BUCKET_MS,
  );
  return bucket.toISOString().replace(/\D/g, '').slice(0, 14);
}

export function managerLiveRefreshJobId(
  scope: ManagerLiveRefreshScope,
  date: Date,
  classicStandingsPage?: number | null,
): string {
  const continuation =
    Number.isSafeInteger(classicStandingsPage) && (classicStandingsPage ?? 0) > 0
      ? `-classic-page-${classicStandingsPage}`
      : '';
  return `manager-live-v1-${scope.seasonCode}-e${scope.eventId}-${scopeSegment(scope)}${continuation}-${managerLiveRefreshBucket(date)}`;
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
