import { createHash, randomUUID } from 'node:crypto';

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
// Tournament imports allow up to 100 Classic standings pages. A worker still
// fetches only two pages per logical run; this is the cursor safety bound, not
// a request-size increase.
export const MANAGER_LIVE_CLASSIC_MAX_PAGE = 100;
// Internal tournament hot state may carry the complete authoritative roster;
// public manager-live reads remain bounded to 500 entry IDs per request.
export const MANAGER_LIVE_TOURNAMENT_ENTRY_LIMIT = 5_000;
// A cursor one past the supported page range is a terminal safety marker. It
// is persisted so a capped crawl cannot refetch page 100 forever; workers do
// not send this sentinel to FPL.
export const MANAGER_LIVE_CLASSIC_CAPPED_CURSOR = MANAGER_LIVE_CLASSIC_MAX_PAGE + 1;

export type ManagerLiveRefreshScope = {
  seasonId: number;
  seasonCode: string;
  eventId: number;
  entryIds: number[];
  tournamentId?: number;
  // A tournament lifecycle marker (or the deterministic entry-set fallback)
  // fences hot-state cleanup across an empty-roster transition. It is not part
  // of the Redis key: changing it must rotate the generation in that key.
  rosterRevision?: string;
};

type ManagerLiveHotRedis = {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

type ManagerLiveHotStateRedis = ManagerLiveHotRedis & {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
};

export type ManagerLiveHotScopeState = ManagerLiveRefreshScope & {
  generation: string;
  rosterRevision: string;
  summaryRotationCursor: number;
  classicStandingsPage: number | null;
  // Distinguishes the initial page-1 cursor from a completed crawl whose
  // page is also null. The epoch advances atomically when a crawl completes,
  // so an older page-1 job cannot reopen a completed cursor.
  classicStandingsCursorEpoch: number;
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

export const managerLiveRosterRevision = (
  entryIds: readonly number[],
  authoritativeMarker?: string | null,
): string => {
  const marker = authoritativeMarker?.trim();
  return marker ? `authoritative:${marker}` : `entries:${entrySetDigest(entryIds)}`;
};

const scopeSegment = (scope: Pick<ManagerLiveRefreshScope, 'entryIds' | 'tournamentId'>): string =>
  scope.tournamentId === undefined
    ? `entries-${entrySetDigest(scope.entryIds)}`
    : `t${scope.tournamentId}`;

export const managerLiveHotScopeKey = (scope: ManagerLiveRefreshScope): string =>
  `llm:queue:manager-live:hot:v1:${scope.seasonCode}:e${scope.eventId}:${scopeSegment(scope)}`;

// v2 keeps the hot marker and both logical refresh cursors in one Redis value.
// The v1 keys remain readable for one release so older test/operational tooling
// can be drained safely, but queue jobs only use this generation-aware state.
export const managerLiveHotStateKey = (scope: ManagerLiveRefreshScope): string =>
  `llm:queue:manager-live:hot:v2:${scope.seasonCode}:e${scope.eventId}:${scopeSegment(scope)}`;

export const managerLiveClassicCursorKey = (scope: ManagerLiveRefreshScope): string =>
  `llm:queue:manager-live:classic-cursor:v1:${scope.seasonCode}:e${scope.eventId}:${scopeSegment(scope)}`;

export function managerLiveRefreshBucket(date: Date): string {
  const bucket = new Date(
    Math.floor(date.getTime() / MANAGER_LIVE_REFRESH_BUCKET_MS) * MANAGER_LIVE_REFRESH_BUCKET_MS,
  );
  return bucket.toISOString().replace(/\D/g, '').slice(0, 14);
}

export function managerLiveFollowupRunAt(requestedRunAt: Date, nowMs = Date.now()): Date {
  const nextBucketAt =
    Math.floor(nowMs / MANAGER_LIVE_REFRESH_BUCKET_MS) * MANAGER_LIVE_REFRESH_BUCKET_MS +
    MANAGER_LIVE_REFRESH_BUCKET_MS;
  const minimumRunAt = Math.max(nowMs + 1_000, nextBucketAt);
  const requestedMs = requestedRunAt.getTime();
  return new Date(Math.max(minimumRunAt, Number.isFinite(requestedMs) ? requestedMs : 0));
}

export function managerLiveRefreshJobId(scope: ManagerLiveRefreshScope, date: Date): string {
  return `manager-live-v1-${scope.seasonCode}-e${scope.eventId}-${scopeSegment(scope)}-${managerLiveRefreshBucket(date)}`;
}

export function managerLiveRefreshJobIdForState(
  scope: ManagerLiveRefreshScope,
  date: Date,
  generation: string,
): string {
  return `manager-live-v2-${scope.seasonCode}-e${scope.eventId}-${scopeSegment(scope)}-g${generation}-${managerLiveRefreshBucket(date)}`;
}

export const parseManagerLiveClassicCursor = (value: string | null): number | null | undefined => {
  if (value === null) return undefined;
  if (value === '0') return null;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= MANAGER_LIVE_CLASSIC_MAX_PAGE
    ? page
    : undefined;
};

export const classicStandingsCursorAfterRefresh = (
  completeRefresh: boolean,
  standings: { complete: boolean; nextPage: number },
): number | null | undefined =>
  completeRefresh
    ? standings.complete
      ? null
      : Math.min(MANAGER_LIVE_CLASSIC_CAPPED_CURSOR, standings.nextPage)
    : undefined;

export const parseManagerLiveHotScope = (value: string | null): ManagerLiveRefreshScope | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ManagerLiveRefreshScope>;
    const entryIds = Array.isArray(parsed.entryIds)
      ? normalizeManagerLiveEntryIds(parsed.entryIds)
      : [];
    const maxEntryIds =
      parsed.tournamentId === undefined ? 500 : MANAGER_LIVE_TOURNAMENT_ENTRY_LIMIT;
    if (
      !Number.isSafeInteger(parsed.seasonId) ||
      typeof parsed.seasonCode !== 'string' ||
      !/^\d{4}$/.test(parsed.seasonCode) ||
      !Number.isSafeInteger(parsed.eventId) ||
      (parsed.eventId ?? 0) <= 0 ||
      entryIds.length === 0 ||
      entryIds.length > maxEntryIds ||
      entryIds.some((entryId) => !Number.isSafeInteger(entryId) || entryId <= 0) ||
      (parsed.tournamentId !== undefined &&
        (!Number.isSafeInteger(parsed.tournamentId) || parsed.tournamentId <= 0)) ||
      (parsed.rosterRevision !== undefined &&
        (typeof parsed.rosterRevision !== 'string' ||
          parsed.rosterRevision.length === 0 ||
          parsed.rosterRevision.length > 256))
    ) {
      return null;
    }
    return {
      seasonId: parsed.seasonId,
      seasonCode: parsed.seasonCode,
      eventId: parsed.eventId,
      entryIds,
      ...(parsed.tournamentId === undefined ? {} : { tournamentId: parsed.tournamentId }),
      ...(parsed.rosterRevision === undefined ? {} : { rosterRevision: parsed.rosterRevision }),
    } as ManagerLiveRefreshScope;
  } catch {
    return null;
  }
};

const parseManagerLiveHotScopeState = (value: string | null): ManagerLiveHotScopeState | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ManagerLiveHotScopeState>;
    const scope = parseManagerLiveHotScope(JSON.stringify(parsed));
    if (
      !scope ||
      typeof parsed.generation !== 'string' ||
      parsed.generation.length === 0 ||
      !Number.isSafeInteger(parsed.summaryRotationCursor) ||
      (parsed.summaryRotationCursor ?? -1) < 0 ||
      (parsed.classicStandingsCursorEpoch !== undefined &&
        (!Number.isSafeInteger(parsed.classicStandingsCursorEpoch) ||
          (parsed.classicStandingsCursorEpoch ?? -1) < 0)) ||
      (parsed.classicStandingsPage !== null &&
        (!Number.isSafeInteger(parsed.classicStandingsPage) ||
          (parsed.classicStandingsPage ?? 0) < 1 ||
          (parsed.classicStandingsPage ?? 0) > MANAGER_LIVE_CLASSIC_CAPPED_CURSOR))
    ) {
      return null;
    }
    return {
      ...scope,
      rosterRevision:
        typeof parsed.rosterRevision === 'string'
          ? parsed.rosterRevision
          : managerLiveRosterRevision(scope.entryIds),
      generation: parsed.generation,
      summaryRotationCursor: parsed.summaryRotationCursor as number,
      classicStandingsPage: parsed.classicStandingsPage ?? null,
      // Older v2 hot states predate the epoch field and are the initial
      // cursor, so they can be safely read as epoch zero for one release.
      classicStandingsCursorEpoch: parsed.classicStandingsCursorEpoch ?? 0,
    };
  } catch {
    return null;
  }
};

const INITIALIZE_HOT_SCOPE_STATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, state = pcall(cjson.decode, current)
  local candidate = cjson.decode(ARGV[2])
  local sameRoster = false
  if ok and state and state['rosterRevision'] == candidate['rosterRevision'] then
    local currentEntries = state['entryIds'] or {}
    local candidateEntries = candidate['entryIds'] or {}
    sameRoster = #currentEntries == #candidateEntries
    if sameRoster then
      for index = 1, #candidateEntries do
        if currentEntries[index] ~= candidateEntries[index] then
          sameRoster = false
          break
        end
      end
    end
  end
  if sameRoster then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    return current
  end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])
  return ARGV[2]
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])
return ARGV[2]
`;

const REPLACE_MALFORMED_HOT_SCOPE_STATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then
  return current
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return ARGV[2]
`;

const RECONCILE_HOT_SCOPE_ROSTER_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])
  return ARGV[2]
end
local state = cjson.decode(current)
local candidate = cjson.decode(ARGV[2])
local currentEntries = state['entryIds'] or {}
local candidateEntries = candidate['entryIds'] or {}
local sameRoster = state['rosterRevision'] == candidate['rosterRevision'] and #currentEntries == #candidateEntries
if sameRoster then
  for index = 1, #candidateEntries do
    if currentEntries[index] ~= candidateEntries[index] then
      sameRoster = false
      break
    end
  end
end
if sameRoster then
  return current
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])
return ARGV[2]
`;

const ADVANCE_HOT_SCOPE_STATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return nil end
local state = cjson.decode(current)
if state['generation'] ~= ARGV[1] then return nil end

local completedCursor = tonumber(ARGV[2])
local currentCursor = tonumber(state['summaryRotationCursor']) or 0
-- A follow-up owns exactly the cursor it processed. Do not let a replay or a
-- malformed job jump over logical chunks that have not run yet.
if completedCursor and currentCursor == completedCursor then
  state['summaryRotationCursor'] = completedCursor + 1
end

if ARGV[3] ~= '' then
  local expectedEpoch = tonumber(ARGV[5]) or 0
  local currentEpoch = tonumber(state['classicStandingsCursorEpoch']) or 0
  local expectedPage = tonumber(ARGV[4])
  local currentPage = tonumber(state['classicStandingsPage'])
  if not currentPage then currentPage = 1 end
  -- A completed crawl has page=null just like the initial cursor. The epoch
  -- makes those states distinct and rejects stale page-1 jobs after the
  -- completion marker has been written.
  if currentEpoch == expectedEpoch and (not expectedPage or currentPage == expectedPage) then
    if ARGV[3] == '0' then
      state['classicStandingsPage'] = cjson.null
      state['classicStandingsCursorEpoch'] = currentEpoch + 1
    else
      state['classicStandingsPage'] = tonumber(ARGV[3])
    end
  end
end

local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return nil end
local encoded = cjson.encode(state)
redis.call('SET', KEYS[1], encoded, 'PX', ttl)
return encoded
`;

const REMOVE_HOT_SCOPE_IF_GENERATION_MATCHES_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current or ARGV[1] == '' or ARGV[2] == '' then return 0 end
local ok, state = pcall(cjson.decode, current)
if not ok or not state or state['generation'] ~= ARGV[1] or state['rosterRevision'] ~= ARGV[2] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export const parseManagerLiveHotState = parseManagerLiveHotScopeState;

export async function initializeManagerLiveHotState(
  redis: ManagerLiveHotStateRedis,
  scope: ManagerLiveRefreshScope,
): Promise<ManagerLiveHotScopeState> {
  const normalizedScope = {
    ...scope,
    entryIds: normalizeManagerLiveEntryIds(scope.entryIds),
    rosterRevision: managerLiveRosterRevision(scope.entryIds, scope.rosterRevision),
  };
  const candidate: ManagerLiveHotScopeState = {
    ...normalizedScope,
    generation: randomUUID(),
    summaryRotationCursor: 0,
    classicStandingsPage: null,
    classicStandingsCursorEpoch: 0,
  };
  const raw = await redis.eval(
    INITIALIZE_HOT_SCOPE_STATE_SCRIPT,
    1,
    managerLiveHotStateKey(scope),
    String(MANAGER_LIVE_HOT_SCOPE_SECONDS),
    JSON.stringify(candidate),
  );
  const rawValue = typeof raw === 'string' ? raw : null;
  const state = parseManagerLiveHotScopeState(rawValue);
  if (state) return state;
  if (rawValue === null) throw new Error('Manager live hot scope state is malformed');

  // A corrupt marker must not become a permanent outage merely because every
  // request renews its TTL. Replace only the exact malformed value we read;
  // if another request already established a valid generation, reuse it.
  const recoveredRaw = await redis.eval(
    REPLACE_MALFORMED_HOT_SCOPE_STATE_SCRIPT,
    1,
    managerLiveHotStateKey(scope),
    rawValue,
    JSON.stringify(candidate),
    String(MANAGER_LIVE_HOT_SCOPE_SECONDS),
  );
  const recoveredState = parseManagerLiveHotScopeState(
    typeof recoveredRaw === 'string' ? recoveredRaw : null,
  );
  if (recoveredState) return recoveredState;
  throw new Error('Manager live hot scope state is malformed');
}

export async function reconcileManagerLiveHotStateRoster(
  redis: ManagerLiveHotStateRedis,
  scope: ManagerLiveRefreshScope,
): Promise<ManagerLiveHotScopeState> {
  const normalizedScope = {
    ...scope,
    entryIds: normalizeManagerLiveEntryIds(scope.entryIds),
    rosterRevision: managerLiveRosterRevision(scope.entryIds, scope.rosterRevision),
  };
  const candidate: ManagerLiveHotScopeState = {
    ...normalizedScope,
    generation: randomUUID(),
    summaryRotationCursor: 0,
    classicStandingsPage: null,
    classicStandingsCursorEpoch: 0,
  };
  const raw = await redis.eval(
    RECONCILE_HOT_SCOPE_ROSTER_SCRIPT,
    1,
    managerLiveHotStateKey(normalizedScope),
    String(MANAGER_LIVE_HOT_SCOPE_SECONDS),
    JSON.stringify(candidate),
  );
  const state = parseManagerLiveHotScopeState(typeof raw === 'string' ? raw : null);
  if (state) return state;
  throw new Error('Manager live hot scope roster reconciliation failed');
}

export async function loadManagerLiveHotState(
  redis: ManagerLiveHotRedis,
  scope: ManagerLiveRefreshScope,
): Promise<ManagerLiveHotScopeState | null> {
  return parseManagerLiveHotScopeState(await redis.get(managerLiveHotStateKey(scope)));
}

export async function removeManagerLiveHotState(
  redis: ManagerLiveHotStateRedis,
  scope: ManagerLiveRefreshScope,
  expectedGeneration?: string,
  expectedRosterRevision?: string,
): Promise<boolean> {
  if (!expectedGeneration) return false;
  const rosterRevision =
    expectedRosterRevision ?? managerLiveRosterRevision(scope.entryIds, scope.rosterRevision);
  const result = await redis.eval(
    REMOVE_HOT_SCOPE_IF_GENERATION_MATCHES_SCRIPT,
    1,
    managerLiveHotStateKey(scope),
    expectedGeneration,
    rosterRevision,
  );
  return Number(result) === 1;
}

export async function advanceManagerLiveHotState(
  redis: ManagerLiveHotStateRedis,
  scope: ManagerLiveRefreshScope,
  generation: string,
  completedSummaryCursor: number,
  classicStandingsNextPage?: number | null,
  expectedClassicStandingsPage?: number | null,
  expectedClassicStandingsCursorEpoch?: number,
): Promise<ManagerLiveHotScopeState | null> {
  if (!generation || !Number.isSafeInteger(completedSummaryCursor) || completedSummaryCursor < 0) {
    throw new Error('Invalid manager live hot state advancement');
  }
  if (
    classicStandingsNextPage !== undefined &&
    classicStandingsNextPage !== null &&
    (!Number.isSafeInteger(classicStandingsNextPage) ||
      classicStandingsNextPage < 1 ||
      classicStandingsNextPage > MANAGER_LIVE_CLASSIC_CAPPED_CURSOR)
  ) {
    throw new Error(
      `Invalid manager live classic standings page: ${String(classicStandingsNextPage)}`,
    );
  }
  if (
    expectedClassicStandingsCursorEpoch !== undefined &&
    (!Number.isSafeInteger(expectedClassicStandingsCursorEpoch) ||
      expectedClassicStandingsCursorEpoch < 0)
  ) {
    throw new Error(
      `Invalid manager live classic standings cursor epoch: ${String(expectedClassicStandingsCursorEpoch)}`,
    );
  }
  if (
    expectedClassicStandingsPage !== undefined &&
    expectedClassicStandingsPage !== null &&
    (!Number.isSafeInteger(expectedClassicStandingsPage) ||
      expectedClassicStandingsPage < 1 ||
      expectedClassicStandingsPage > MANAGER_LIVE_CLASSIC_CAPPED_CURSOR)
  ) {
    throw new Error(
      `Invalid expected manager live classic standings page: ${String(expectedClassicStandingsPage)}`,
    );
  }
  const classicUpdate =
    classicStandingsNextPage === undefined
      ? ''
      : classicStandingsNextPage === null
        ? '0'
        : String(classicStandingsNextPage);
  const expectedPage =
    expectedClassicStandingsPage === undefined || expectedClassicStandingsPage === null
      ? ''
      : String(expectedClassicStandingsPage);
  const raw = await redis.eval(
    ADVANCE_HOT_SCOPE_STATE_SCRIPT,
    1,
    managerLiveHotStateKey(scope),
    generation,
    String(completedSummaryCursor),
    classicUpdate,
    expectedPage,
    String(expectedClassicStandingsCursorEpoch ?? 0),
  );
  return parseManagerLiveHotScopeState(typeof raw === 'string' ? raw : null);
}

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

/**
 * Legacy v1 cursor helpers retained for one release while old queue data drains.
 * v2 workers use the generation-aware hot state above, so this key is never
 * consulted for a live continuation and cannot race a restarted scope.
 */
export async function writeManagerLiveClassicCursor(
  redis: ManagerLiveHotRedis,
  scope: ManagerLiveRefreshScope,
  page: number | null,
): Promise<void> {
  if (
    page !== null &&
    (!Number.isSafeInteger(page) || page < 1 || page > MANAGER_LIVE_CLASSIC_MAX_PAGE)
  ) {
    throw new Error(`Invalid manager live classic standings page: ${String(page)}`);
  }
  await redis.set(
    managerLiveClassicCursorKey(scope),
    page === null ? '0' : String(page),
    'EX',
    MANAGER_LIVE_HOT_SCOPE_SECONDS,
  );
}

export async function loadManagerLiveClassicCursor(
  redis: ManagerLiveHotRedis,
  scope: ManagerLiveRefreshScope,
): Promise<number | null | undefined> {
  return parseManagerLiveClassicCursor(await redis.get(managerLiveClassicCursorKey(scope)));
}
