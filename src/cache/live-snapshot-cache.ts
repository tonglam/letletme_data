import { createHash, randomUUID } from 'crypto';

import type Redis from 'ioredis';

import type { EventLive } from '../domain/event-lives';
import type { LiveBonusByTeam } from '../domain/live-bonus';
import type { LiveFixturesByTeam, LiveFixturesV2ByTeam } from '../domain/live-fixtures';
import type { Fixture } from '../types';
import {
  LIVE_SNAPSHOT_SCHEMA_VERSION,
  parseLiveSnapshotMeta,
  type LiveSnapshotMeta,
  type LiveSnapshotState,
} from '../domain/live-snapshot';
import { logError, logInfo, logWarn } from '../utils/logger';
import {
  ACTIVE_SEASON_KEY,
  getActiveCacheSeason,
  getActiveCacheSeasonUncached,
} from './cache-season';
import { liveSnapshotMetaKey } from './live-snapshot-ownership';
import { redisSingleton } from './singleton';

export { LIVE_SNAPSHOT_META_PREFIX } from './live-snapshot-ownership';
export const LIVE_SNAPSHOT_STAGING_TTL_SECONDS = 15 * 60;

type HashFields = Record<string, string>;

export interface LiveSnapshotCachePayload {
  /** Season whose roster and reference data produced every derived view. */
  season: string;
  eventId: number;
  state: LiveSnapshotState;
  eventLives: readonly EventLive[];
  fixtures: readonly Fixture[];
  liveFixtures: LiveFixturesByTeam;
  liveFixturesV2: LiveFixturesV2ByTeam;
  liveBonus: LiveBonusByTeam;
  liveBonusV2: LiveBonusByTeam;
  checkedAt?: Date;
}

export interface LiveSnapshotPublishResult {
  changed: boolean;
  stale: boolean;
  meta: LiveSnapshotMeta;
}

export interface LiveSnapshotPublishOptions {
  /**
   * Complete required durable writes after every view has been staged and
   * verified, but before the atomic Redis swap exposes the new revision.
   * Returning false means PostgreSQL's durable ordering fence already belongs
   * to a newer worker, so this cache candidate must not be published.
   */
  beforeCommit?: (changed: boolean) => Promise<boolean | void>;
}

export interface LiveSnapshotRetireResult {
  eventId: number;
  removedKeys: number;
}

export interface LiveSnapshotFixtureRefreshResult {
  eventId: number;
  owned: boolean;
  retired: boolean;
}

type LiveSnapshotCacheDependencies = {
  getRedisClient: () => Promise<Redis>;
  getSeason: () => Promise<string>;
  getAuthoritativeSeason: () => Promise<string>;
};

const defaultDependencies: LiveSnapshotCacheDependencies = {
  getRedisClient: () => redisSingleton.getClient(),
  getSeason: getActiveCacheSeason,
  getAuthoritativeSeason: getActiveCacheSeasonUncached,
};

const LIVE_SNAPSHOT_VIEW_PREFIXES = [
  'EventLive',
  'Fixtures',
  'LiveFixture',
  'LiveFixtureV2',
  'LiveBonus',
  'LiveBonusV2',
] as const;
const FIXTURES_KEY_INDEX = LIVE_SNAPSHOT_VIEW_PREFIXES.indexOf('Fixtures') + 1;
const LIVE_BONUS_V2_KEY_INDEX = LIVE_SNAPSHOT_VIEW_PREFIXES.indexOf('LiveBonusV2') + 1;

const LIVE_SNAPSHOT_META_VALIDATION_LUA = `
local function is_nonnegative_integer(value)
  return type(value) == 'number' and value >= 0 and value == math.floor(value)
end

local function is_positive_integer(value)
  return is_nonnegative_integer(value) and value > 0
end

local function is_leap_year(year)
  return year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0)
end

local function is_canonical_timestamp(value)
  if type(value) ~= 'string' or string.len(value) ~= 24 then
    return false
  end
  local year_raw, month_raw, day_raw, hour_raw, minute_raw, second_raw = string.match(
    value,
    '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d%d%dZ$'
  )
  if year_raw == nil then
    return false
  end
  local year = tonumber(year_raw)
  local month = tonumber(month_raw)
  local day = tonumber(day_raw)
  local hour = tonumber(hour_raw)
  local minute = tonumber(minute_raw)
  local second = tonumber(second_raw)
  if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59 then
    return false
  end
  local month_days = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
  if month == 2 and is_leap_year(year) then
    month_days[2] = 29
  end
  return day >= 1 and day <= month_days[month]
end

local function is_live_snapshot_meta(value)
  return type(value) == 'table'
    and value.schemaVersion == 1
    and type(value.season) == 'string'
    and string.match(value.season, '^%d%d%d%d$') ~= nil
    and is_positive_integer(value.eventId)
    and type(value.revision) == 'string'
    and string.len(value.revision) == 24
    and string.match(value.revision, '^[0-9a-f]+$') ~= nil
    and (value.state == 'scheduled' or value.state == 'live' or value.state == 'settled')
    and is_canonical_timestamp(value.publishedAt)
    and is_canonical_timestamp(value.checkedAt)
    and is_positive_integer(value.eventLiveCount)
    and is_positive_integer(value.fixtureCount)
    and is_positive_integer(value.fixtureTeamCount)
    and is_nonnegative_integer(value.bonusTeamCount)
end
`;

const SET_LIVE_SNAPSHOT_META_IF_FRESH_SCRIPT = `${LIVE_SNAPSHOT_META_VALIDATION_LUA}
if redis.call('GET', KEYS[2]) ~= ARGV[3] then
  return -2
end
local current_raw = redis.pcall('GET', KEYS[1])
if type(current_raw) == 'string' then
  local decoded, current = pcall(cjson.decode, current_raw)
  if decoded and is_live_snapshot_meta(current) and current.checkedAt > ARGV[2] then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

const RETIRE_LIVE_SNAPSHOT_SCRIPT = `
local removed = 0
for index = 1, #KEYS do
  removed = removed + redis.call('DEL', KEYS[index])
end
return removed
`;

// Late FPL fixture corrections must not be hidden by snapshot ownership. If
// either the accepted fixture rows or fixture-derived V2 bonus differs, retire
// all coordinated views and publish the corrected unowned source hashes in the
// same Redis script. Coherent readers then use the durable fallback until the
// next complete snapshot publication.
const REFRESH_FIXTURE_DERIVATIVES_SCRIPT = `
if redis.call('GET', KEYS[#KEYS]) ~= ARGV[3] then
  return -2
end

local function entry_count(values)
  local count = 0
  for _ in pairs(values) do
    count = count + 1
  end
  return count
end

local function hash_matches(key, expected)
  local expected_count = entry_count(expected)
  local actual_count = redis.pcall('HLEN', key)
  if type(actual_count) ~= 'number' or actual_count ~= expected_count then
    return false
  end
  for field, value in pairs(expected) do
    if redis.pcall('HGET', key, field) ~= value then
      return false
    end
  end
  return true
end

local function replace_hash(key, values)
  redis.call('DEL', key)
  for field, value in pairs(values) do
    redis.call('HSET', key, field, value)
  end
end

local expected_fixtures = cjson.decode(ARGV[1])
local expected_bonus = cjson.decode(ARGV[2])
local fixtures_key = KEYS[tonumber(ARGV[4])]
local bonus_key = KEYS[tonumber(ARGV[5])]
local meta_key = KEYS[#KEYS - 1]
local owned = redis.call('EXISTS', meta_key) == 1
local matches = hash_matches(fixtures_key, expected_fixtures)
  and hash_matches(bonus_key, expected_bonus)
local meta_raw = redis.pcall('GET', meta_key)
if owned then
  local decoded, meta = pcall(cjson.decode, meta_raw)
  if not decoded
    or type(meta) ~= 'table'
    or meta.fixtureCount ~= entry_count(expected_fixtures)
    or meta.bonusTeamCount ~= entry_count(expected_bonus)
  then
    matches = false
  end
end

if matches then
  return owned and 1 or 0
end

if owned then
  for index = 1, #KEYS - 1 do
    redis.call('DEL', KEYS[index])
  end
end
replace_hash(fixtures_key, expected_fixtures)
replace_hash(bonus_key, expected_bonus)
return owned and 2 or 0
`;

/**
 * Validate every staging hash before changing any published key, then swap all
 * views and metadata in one Redis script. Redis transactions execute later
 * commands after a runtime command error; the preflight inside this atomic
 * script prevents that failure mode from exposing a mixed revision.
 */
const PUBLISH_LIVE_SNAPSHOT_SCRIPT = `${LIVE_SNAPSHOT_META_VALIDATION_LUA}
local staged_count = tonumber(ARGV[1])
local empty_count = tonumber(ARGV[2])
local meta_key = KEYS[(staged_count * 2) + empty_count + 1]
local active_season_key = KEYS[(staged_count * 2) + empty_count + 2]

if redis.call('GET', active_season_key) ~= ARGV[5] then
  return -2
end

for index = 1, staged_count do
  if redis.call('EXISTS', KEYS[index]) ~= 1 then
    return redis.error_reply('missing live snapshot staging key')
  end
end

local current_raw = redis.pcall('GET', meta_key)
if type(current_raw) == 'string' then
  local decoded, current = pcall(cjson.decode, current_raw)
  if decoded and is_live_snapshot_meta(current) and current.checkedAt > ARGV[4] then
    return -1
  end
end

for index = 1, staged_count do
  redis.call('RENAME', KEYS[index], KEYS[staged_count + index])
  redis.call('PERSIST', KEYS[staged_count + index])
end

for index = 1, empty_count do
  redis.call('DEL', KEYS[(staged_count * 2) + index])
end

redis.call('SET', meta_key, ARGV[3])
return staged_count
`;

function eventLivesToHash(rows: readonly EventLive[]): HashFields {
  const fields: HashFields = {};
  for (const row of [...rows].sort((a, b) => a.elementId - b.elementId)) {
    fields[String(row.elementId)] = JSON.stringify(row);
  }
  return fields;
}

function recordToHash<T>(record: Readonly<Record<string, T>>): HashFields {
  const fields: HashFields = {};
  for (const key of Object.keys(record).sort((a, b) => Number(a) - Number(b))) {
    fields[key] = JSON.stringify(record[key]);
  }
  return fields;
}

function liveBonusToHash(byTeam: LiveBonusByTeam): HashFields {
  const fields: HashFields = {};
  for (const teamId of Object.keys(byTeam).sort((a, b) => Number(a) - Number(b))) {
    const sortedBonus: Record<string, number> = {};
    for (const elementId of Object.keys(byTeam[teamId]).sort((a, b) => Number(a) - Number(b))) {
      sortedBonus[elementId] = byTeam[teamId][elementId];
    }
    fields[teamId] = JSON.stringify(sortedBonus);
  }
  return fields;
}

function fixturesToHash(fixtures: readonly Fixture[]): HashFields {
  return recordToHash(Object.fromEntries(fixtures.map((fixture) => [String(fixture.id), fixture])));
}

function snapshotRevision(views: ReadonlyArray<{ name: string; fields: HashFields }>): string {
  const hash = createHash('sha256');
  for (const view of [...views].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(view.name);
    hash.update('\0');
    for (const field of Object.keys(view.fields).sort()) {
      hash.update(field);
      hash.update('\0');
      hash.update(view.fields[field]);
      hash.update('\0');
    }
  }
  return hash.digest('hex').slice(0, 24);
}

async function stageHash(redis: Redis, targetKey: string, fields: HashFields): Promise<string> {
  const stagingKey = `${targetKey}:staging:${randomUUID()}`;
  const expected = Object.keys(fields).length;
  try {
    const staged = await redis
      .multi()
      .hset(stagingKey, fields)
      .expire(stagingKey, LIVE_SNAPSHOT_STAGING_TTL_SECONDS)
      .exec();
    if (!staged) {
      throw new Error(`Live snapshot staging transaction aborted for ${targetKey}`);
    }
    const commandError = staged.find(([error]) => error)?.[0];
    if (commandError) throw commandError;
    const actual = await redis.hlen(stagingKey);
    if (actual !== expected) {
      throw new Error(`Incomplete live snapshot staging hash ${targetKey}: ${actual}/${expected}`);
    }
    return stagingKey;
  } catch (error) {
    try {
      await redis.del(stagingKey);
    } catch {
      // Preserve the staging failure. The bounded staging TTL is the crash fallback.
    }
    throw error;
  }
}

function isWrongTypeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('WRONGTYPE');
}

async function readPublishedMeta(redis: Redis, metaKey: string): Promise<LiveSnapshotMeta | null> {
  try {
    return parseLiveSnapshotMeta(await redis.get(metaKey));
  } catch (error) {
    if (!isWrongTypeError(error)) throw error;
    logWarn('Replacing wrong-type live snapshot metadata key', { metaKey });
    return null;
  }
}

function isPublishedMetaNewer(meta: LiveSnapshotMeta, checkedAt: Date): boolean {
  return Date.parse(meta.checkedAt) > checkedAt.getTime();
}

async function stalePublishResult(
  redis: Redis,
  metaKey: string,
  eventId: number,
  incomingCheckedAt: string,
): Promise<LiveSnapshotPublishResult> {
  const winner = await readPublishedMeta(redis, metaKey);
  const incomingTime = Date.parse(incomingCheckedAt);
  if (!winner || Date.parse(winner.checkedAt) <= incomingTime) {
    throw new Error(`Stale live snapshot ${eventId} is awaiting newer published winner metadata`);
  }
  logInfo('Rejected stale live snapshot publication', {
    eventId,
    incomingCheckedAt,
    winnerCheckedAt: winner.checkedAt,
    winnerRevision: winner.revision,
  });
  return { changed: false, stale: true, meta: winner };
}

async function publishedHashMatches(
  redis: Redis,
  key: string,
  expectedFields: HashFields,
): Promise<boolean> {
  try {
    const fieldNames = Object.keys(expectedFields);
    if ((await redis.hlen(key)) !== fieldNames.length) return false;
    const values = await redis.hmget(key, ...fieldNames);
    return values.every((value, index) => value === expectedFields[fieldNames[index]]);
  } catch (error) {
    if (!isWrongTypeError(error)) throw error;
    logWarn('Replacing wrong-type live snapshot view', { key });
    return false;
  }
}

export function createLiveSnapshotCache(
  dependencies: LiveSnapshotCacheDependencies = defaultDependencies,
) {
  async function assertPreparedSeasonActive(
    preparedSeason: string,
    eventId: number,
    boundary: string,
  ): Promise<void> {
    const activeSeason = await dependencies.getAuthoritativeSeason();
    if (activeSeason === preparedSeason) return;
    logWarn('Refusing live snapshot operation after active season changed', {
      preparedSeason,
      activeSeason,
      eventId,
      boundary,
    });
    throw new Error(
      `Live snapshot season changed from ${preparedSeason} to ${activeSeason}; retry with current reference data`,
    );
  }

  return {
    async get(eventId: number): Promise<LiveSnapshotMeta | null> {
      const [redis, season] = await Promise.all([
        dependencies.getRedisClient(),
        dependencies.getSeason(),
      ]);
      return parseLiveSnapshotMeta(await redis.get(liveSnapshotMetaKey(season, eventId)));
    },

    /**
     * Fixture rescheduling invalidates every event-scoped derivative, not just
     * Fixtures. Remove the metadata pointer and all six coordinated views in
     * one command so readers either see the old snapshot or a complete miss.
     */
    async retire(eventId: number): Promise<LiveSnapshotRetireResult> {
      const [redis, season] = await Promise.all([
        dependencies.getRedisClient(),
        dependencies.getAuthoritativeSeason(),
      ]);
      const keys = [
        ...LIVE_SNAPSHOT_VIEW_PREFIXES.map((prefix) => `${prefix}:${season}:${eventId}`),
        liveSnapshotMetaKey(season, eventId),
      ];
      const removedKeys = Number(
        await redis.eval(RETIRE_LIVE_SNAPSHOT_SCRIPT, keys.length, ...keys),
      );
      if (!Number.isInteger(removedKeys) || removedKeys < 0) {
        throw new Error(`Unexpected live snapshot retirement result: ${String(removedKeys)}`);
      }
      logInfo('Atomically retired live snapshot ownership', { eventId, season, removedKeys });
      return { eventId, removedKeys };
    },

    /**
     * Reconcile accepted fixture rows and their V2 bonus source without
     * allowing snapshot ownership to preserve stale score/status/kickoff data.
     * A changed owned source retires the entire snapshot and writes corrected
     * unowned source hashes; coherent readers then fall back durably until a
     * full republish derives every view from one upstream pair.
     */
    async refreshFixtureDerivatives(
      eventId: number,
      fixtures: readonly Fixture[],
      byTeam: LiveBonusByTeam,
    ): Promise<LiveSnapshotFixtureRefreshResult> {
      if (fixtures.length === 0) {
        throw new Error(
          `Refusing empty fixture-derived refresh for live snapshot event ${eventId}`,
        );
      }
      const [redis, season] = await Promise.all([
        dependencies.getRedisClient(),
        dependencies.getAuthoritativeSeason(),
      ]);
      const keys = [
        ...LIVE_SNAPSHOT_VIEW_PREFIXES.map((prefix) => `${prefix}:${season}:${eventId}`),
        liveSnapshotMetaKey(season, eventId),
        ACTIVE_SEASON_KEY,
      ];
      const result = Number(
        await redis.eval(
          REFRESH_FIXTURE_DERIVATIVES_SCRIPT,
          keys.length,
          ...keys,
          JSON.stringify(fixturesToHash(fixtures)),
          JSON.stringify(liveBonusToHash(byTeam)),
          season,
          String(FIXTURES_KEY_INDEX),
          String(LIVE_BONUS_V2_KEY_INDEX),
        ),
      );
      if (result === -2) {
        throw new Error(
          `Live fixture-derived season changed from ${season} before coordinated refresh; retry`,
        );
      }
      if (result !== 0 && result !== 1 && result !== 2) {
        throw new Error(`Unexpected coordinated fixture refresh result: ${String(result)}`);
      }

      const refresh = {
        eventId,
        owned: result !== 0,
        retired: result === 2,
      };
      if (refresh.retired) {
        logInfo('Retired live snapshot after accepted fixture derivatives changed', {
          eventId,
          season,
          fixtureCount: fixtures.length,
          teamCount: Object.keys(byTeam).length,
        });
      }
      return refresh;
    },

    async publish(
      payload: LiveSnapshotCachePayload,
      options: LiveSnapshotPublishOptions = {},
    ): Promise<LiveSnapshotPublishResult> {
      const checkedAt = payload.checkedAt ?? new Date();
      const [redis] = await Promise.all([
        dependencies.getRedisClient(),
        assertPreparedSeasonActive(payload.season, payload.eventId, 'publication preflight'),
      ]);
      // From here on, key construction is bound to the reference-data season;
      // the active-season read above is only a publication fence.
      const season = payload.season;
      const metaKey = liveSnapshotMetaKey(season, payload.eventId);

      const views = [
        {
          name: 'EventLive',
          key: `EventLive:${season}:${payload.eventId}`,
          fields: eventLivesToHash(payload.eventLives),
          required: true,
        },
        {
          name: 'Fixtures',
          key: `Fixtures:${season}:${payload.eventId}`,
          fields: fixturesToHash(payload.fixtures),
          required: true,
        },
        {
          name: 'LiveFixture',
          key: `LiveFixture:${season}:${payload.eventId}`,
          fields: recordToHash(payload.liveFixtures),
          required: true,
        },
        {
          name: 'LiveFixtureV2',
          key: `LiveFixtureV2:${season}:${payload.eventId}`,
          fields: recordToHash(payload.liveFixturesV2),
          required: true,
        },
        {
          name: 'LiveBonus',
          key: `LiveBonus:${season}:${payload.eventId}`,
          fields: liveBonusToHash(payload.liveBonus),
          required: false,
        },
        {
          name: 'LiveBonusV2',
          key: `LiveBonusV2:${season}:${payload.eventId}`,
          fields: liveBonusToHash(payload.liveBonusV2),
          required: false,
        },
      ] as const;

      for (const view of views) {
        if (view.required && Object.keys(view.fields).length === 0) {
          throw new Error(`Refusing to publish empty ${view.name} live snapshot view`);
        }
      }

      const revision = snapshotRevision(views);
      const currentMeta = await readPublishedMeta(redis, metaKey);
      if (currentMeta && isPublishedMetaNewer(currentMeta, checkedAt)) {
        return stalePublishResult(redis, metaKey, payload.eventId, checkedAt.toISOString());
      }
      const populatedViews = views.filter((view) => Object.keys(view.fields).length > 0);
      const emptyKeys = views
        .filter((view) => Object.keys(view.fields).length === 0)
        .map((view) => view.key);
      const [publishedViewsMatch, staleEmptyViewCount] = await Promise.all([
        Promise.all(
          populatedViews.map((view) => publishedHashMatches(redis, view.key, view.fields)),
        ),
        emptyKeys.length > 0 ? redis.exists(...emptyKeys) : Promise.resolve(0),
      ]);
      const populatedViewsComplete = publishedViewsMatch.every(Boolean);
      const changed =
        currentMeta?.revision !== revision || !populatedViewsComplete || staleEmptyViewCount > 0;
      const publishedAt =
        changed || !currentMeta ? checkedAt.toISOString() : currentMeta.publishedAt;
      const meta: LiveSnapshotMeta = {
        schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
        season,
        eventId: payload.eventId,
        revision,
        state: payload.state,
        publishedAt,
        checkedAt: checkedAt.toISOString(),
        eventLiveCount: payload.eventLives.length,
        fixtureCount: payload.fixtures.length,
        fixtureTeamCount: Object.keys(payload.liveFixturesV2).length,
        bonusTeamCount: Object.keys(payload.liveBonusV2).length,
      };

      if (!changed) {
        await assertPreparedSeasonActive(season, payload.eventId, 'durable commit');
        const durableAccepted = (await options.beforeCommit?.(false)) !== false;
        if (!durableAccepted) {
          return stalePublishResult(redis, metaKey, payload.eventId, meta.checkedAt);
        }
        const updated = await redis.eval(
          SET_LIVE_SNAPSHOT_META_IF_FRESH_SCRIPT,
          2,
          metaKey,
          ACTIVE_SEASON_KEY,
          JSON.stringify(meta),
          meta.checkedAt,
          season,
        );
        if (updated === -2) {
          throw new Error(
            `Live snapshot season changed from ${season} before Redis metadata commit; retry`,
          );
        }
        if (updated === 0) {
          return stalePublishResult(redis, metaKey, payload.eventId, meta.checkedAt);
        }
        if (updated !== 1) {
          throw new Error(`Unexpected live snapshot metadata update result: ${String(updated)}`);
        }
        logInfo('Live snapshot checked with no football data change', {
          eventId: payload.eventId,
          revision,
          checkedAt: meta.checkedAt,
        });
        return { changed: false, stale: false, meta };
      }

      const staged: Array<{ targetKey: string; stagingKey: string }> = [];
      try {
        const stageResults = await Promise.allSettled(
          views
            .filter((view) => Object.keys(view.fields).length > 0)
            .map(async (view) => ({
              targetKey: view.key,
              stagingKey: await stageHash(redis, view.key, view.fields),
            })),
        );
        for (const result of stageResults) {
          if (result.status === 'fulfilled') staged.push(result.value);
        }
        const stageFailure = stageResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (stageFailure) throw stageFailure.reason;

        const stagedKeys = staged.map((view) => view.stagingKey);
        const targetKeys = staged.map((view) => view.targetKey);
        const emptyTargetKeys = views
          .filter((view) => !staged.some((candidate) => candidate.targetKey === view.key))
          .map((view) => view.key);
        await assertPreparedSeasonActive(season, payload.eventId, 'durable commit');
        const durableAccepted = (await options.beforeCommit?.(true)) !== false;
        if (!durableAccepted) {
          if (stagedKeys.length > 0) await redis.del(...stagedKeys);
          return stalePublishResult(redis, metaKey, payload.eventId, meta.checkedAt);
        }
        const result = await redis.eval(
          PUBLISH_LIVE_SNAPSHOT_SCRIPT,
          stagedKeys.length * 2 + emptyTargetKeys.length + 2,
          ...stagedKeys,
          ...targetKeys,
          ...emptyTargetKeys,
          metaKey,
          ACTIVE_SEASON_KEY,
          String(stagedKeys.length),
          String(emptyTargetKeys.length),
          JSON.stringify(meta),
          meta.checkedAt,
          season,
        );
        if (result === -2) {
          throw new Error(
            `Live snapshot season changed from ${season} before Redis publication commit; retry`,
          );
        }
        if (result === -1) {
          if (stagedKeys.length > 0) await redis.del(...stagedKeys);
          return stalePublishResult(redis, metaKey, payload.eventId, meta.checkedAt);
        }
        if (result !== stagedKeys.length) {
          throw new Error(`Unexpected live snapshot publish result: ${String(result)}`);
        }

        logInfo('Atomically published changed live snapshot', {
          eventId: payload.eventId,
          revision,
          state: payload.state,
          eventLiveCount: meta.eventLiveCount,
          fixtureCount: meta.fixtureCount,
          bonusTeamCount: meta.bonusTeamCount,
        });
        return { changed: true, stale: false, meta };
      } catch (error) {
        if (staged.length > 0) {
          try {
            await redis.del(...staged.map((view) => view.stagingKey));
          } catch {
            // Preserve the publication error; staging keys are uniquely named.
          }
        }
        logError('Failed to publish live snapshot', error, {
          eventId: payload.eventId,
          revision,
        });
        throw error;
      }
    },
  };
}

export const liveSnapshotCache = createLiveSnapshotCache();
