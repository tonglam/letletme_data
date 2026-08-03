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
import { getActiveCacheSeason } from './cache-season';
import { redisSingleton } from './singleton';

export const LIVE_SNAPSHOT_META_PREFIX = 'LiveSnapshotMeta';
export const LIVE_SNAPSHOT_STAGING_TTL_SECONDS = 15 * 60;

type HashFields = Record<string, string>;

export interface LiveSnapshotCachePayload {
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
  meta: LiveSnapshotMeta;
}

export interface LiveSnapshotPublishOptions {
  /**
   * Complete required durable writes after every view has been staged and
   * verified, but before the atomic Redis swap exposes the new revision.
   */
  beforeCommit?: () => Promise<void>;
}

type LiveSnapshotCacheDependencies = {
  getRedisClient: () => Promise<Redis>;
  getSeason: () => Promise<string>;
};

const defaultDependencies: LiveSnapshotCacheDependencies = {
  getRedisClient: () => redisSingleton.getClient(),
  getSeason: getActiveCacheSeason,
};

/**
 * Validate every staging hash before changing any published key, then swap all
 * views and metadata in one Redis script. Redis transactions execute later
 * commands after a runtime command error; the preflight inside this atomic
 * script prevents that failure mode from exposing a mixed revision.
 */
const PUBLISH_LIVE_SNAPSHOT_SCRIPT = `
local staged_count = tonumber(ARGV[1])
local empty_count = tonumber(ARGV[2])

for index = 1, staged_count do
  if redis.call('EXISTS', KEYS[index]) ~= 1 then
    return redis.error_reply('missing live snapshot staging key')
  end
end

for index = 1, staged_count do
  redis.call('RENAME', KEYS[index], KEYS[staged_count + index])
  redis.call('PERSIST', KEYS[staged_count + index])
end

for index = 1, empty_count do
  redis.call('DEL', KEYS[(staged_count * 2) + index])
end

redis.call('SET', KEYS[(staged_count * 2) + empty_count + 1], ARGV[3])
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
  return {
    async get(eventId: number): Promise<LiveSnapshotMeta | null> {
      const [redis, season] = await Promise.all([
        dependencies.getRedisClient(),
        dependencies.getSeason(),
      ]);
      return parseLiveSnapshotMeta(
        await redis.get(`${LIVE_SNAPSHOT_META_PREFIX}:${season}:${eventId}`),
      );
    },

    async publish(
      payload: LiveSnapshotCachePayload,
      options: LiveSnapshotPublishOptions = {},
    ): Promise<LiveSnapshotPublishResult> {
      const checkedAt = payload.checkedAt ?? new Date();
      const [redis, season] = await Promise.all([
        dependencies.getRedisClient(),
        dependencies.getSeason(),
      ]);
      const metaKey = `${LIVE_SNAPSHOT_META_PREFIX}:${season}:${payload.eventId}`;

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
          fields: recordToHash(
            Object.fromEntries(payload.fixtures.map((fixture) => [String(fixture.id), fixture])),
          ),
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
          fields: recordToHash(payload.liveBonus),
          required: false,
        },
        {
          name: 'LiveBonusV2',
          key: `LiveBonusV2:${season}:${payload.eventId}`,
          fields: recordToHash(payload.liveBonusV2),
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
        await redis.set(metaKey, JSON.stringify(meta));
        logInfo('Live snapshot checked with no football data change', {
          eventId: payload.eventId,
          revision,
          checkedAt: meta.checkedAt,
        });
        return { changed: false, meta };
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
        await options.beforeCommit?.();
        const result = await redis.eval(
          PUBLISH_LIVE_SNAPSHOT_SCRIPT,
          stagedKeys.length * 2 + emptyTargetKeys.length + 1,
          ...stagedKeys,
          ...targetKeys,
          ...emptyTargetKeys,
          metaKey,
          String(stagedKeys.length),
          String(emptyTargetKeys.length),
          JSON.stringify(meta),
        );
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
        return { changed: true, meta };
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
