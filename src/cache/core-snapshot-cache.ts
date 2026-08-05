import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { selectCurrentEventByDeadline } from '../domain/events';
import { CacheError } from '../utils/errors';
import { logWarn } from '../utils/logger';
import {
  ACTIVE_SEASON_KEY,
  isNewerSeason,
  rememberCoreSnapshotActiveSeason,
  resetActiveSeasonMemo,
} from './cache-season';
import { buildFixturesByTeam } from './fixtures-cache';
import { liveSnapshotMetaKey } from './live-snapshot-ownership';
import { redisSingleton } from './singleton';

import type { CoreSnapshot } from '../domain/core-snapshot';
import type { Event, Fixture, Player } from '../types';

type HashFields = Record<string, string>;

export interface CoreSnapshotCachePlan {
  hashes: Map<string, HashFields>;
  currentEvent: string | null;
}

export interface CoreSnapshotCachePublication {
  published: boolean;
  reason: 'published' | 'newer_active_season';
  hashCount: number;
  receipt?: CoreSnapshotCachePublicationReceipt;
}

export interface CoreSnapshotCachePublicationReceipt {
  publicationId: string;
  season: string;
  sourceCheckedAt: string;
  fixtureIds: number[];
  previousActiveSeason: string | null;
  finalKeys: string[];
  backups: Array<{ key: string; backupKey: string }>;
  currentEventBackupKey: string;
}

type PublishOptions = {
  redis?: Redis;
  publicationId?: string;
  sourceCheckedAt?: Date;
  afterStage?: () => Promise<void>;
};

export const CORE_SNAPSHOT_PENDING_PUBLICATION_KEY = 'CoreSnapshotPublication:pending';
export const CORE_SNAPSHOT_STAGING_TTL_MS = 15 * 60_000;

const PUBLISH_SCRIPT = `
local payload = cjson.decode(ARGV[1])
local active = redis.call('GET', KEYS[1])
local normalizedActive = active or ''
if normalizedActive ~= payload.expectedActive then
  return {'authority_changed', normalizedActive}
end
if redis.call('EXISTS', KEYS[3]) == 1 then
  return {'pending_publication'}
end
for _, item in ipairs(payload.staged) do
  if redis.call('EXISTS', item.stageKey) ~= 1 then
    return {'missing_stage', item.stageKey}
  end
  if redis.call('HLEN', item.stageKey) ~= item.expectedCount then
    return {'invalid_stage', item.stageKey}
  end
end
for _, item in ipairs(payload.backups) do
  local snapshotOwned = item.metaKey and redis.call('EXISTS', item.metaKey) == 1
  if not snapshotOwned and redis.call('EXISTS', item.key) == 1 then
    redis.call('DEL', item.backupKey)
    redis.call('RENAME', item.key, item.backupKey)
  end
end
redis.call('DEL', payload.currentEventBackupKey)
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('RENAME', KEYS[2], payload.currentEventBackupKey)
end
local finalKeys = {}
local backups = {}
for _, item in ipairs(payload.backups) do
  local snapshotOwned = item.metaKey and redis.call('EXISTS', item.metaKey) == 1
  if not snapshotOwned then
    table.insert(backups, {key = item.key, backupKey = item.backupKey})
  end
end
for _, item in ipairs(payload.staged) do
  local snapshotOwned = item.metaKey and redis.call('EXISTS', item.metaKey) == 1
  if not snapshotOwned then
    redis.call('RENAME', item.stageKey, item.finalKey)
    table.insert(finalKeys, item.finalKey)
  end
end
if payload.currentEvent == cjson.null then
  redis.call('DEL', KEYS[2])
else
  redis.call('SET', KEYS[2], payload.currentEvent)
end
redis.call('SET', KEYS[1], payload.season)
local receipt = {
  publicationId = payload.publicationId,
  season = payload.season,
  sourceCheckedAt = payload.sourceCheckedAt,
  fixtureIds = payload.fixtureIds,
  previousActiveSeason = payload.previousActiveSeason,
  finalKeys = finalKeys,
  backups = backups,
  currentEventBackupKey = payload.currentEventBackupKey
}
local encodedReceipt = cjson.encode(receipt)
redis.call('SET', KEYS[3], encodedReceipt)
return {'published', tostring(#finalKeys), encodedReceipt}
`;

const FINALIZE_SCRIPT = `
local pending = redis.call('GET', KEYS[1])
if not pending then return {'noop'} end
local stored = cjson.decode(pending)
local receipt = cjson.decode(ARGV[1])
if stored.publicationId ~= receipt.publicationId then
  return {'different_publication'}
end
for _, item in ipairs(receipt.backups) do redis.call('DEL', item.backupKey) end
redis.call('DEL', receipt.currentEventBackupKey)
redis.call('DEL', KEYS[1])
return {'finalized'}
`;

const ROLLBACK_SCRIPT = `
local pending = redis.call('GET', KEYS[3])
if not pending then return {'noop'} end
local stored = cjson.decode(pending)
local receipt = cjson.decode(ARGV[1])
if stored.publicationId ~= receipt.publicationId then
  return {'different_publication'}
end

local fixture_prefix = 'Fixtures:' .. receipt.season .. ':'
local function live_snapshot_owns(key)
  if string.sub(key, 1, string.len(fixture_prefix)) ~= fixture_prefix then
    return false
  end
  local event_id = string.sub(key, string.len(fixture_prefix) + 1)
  if string.match(event_id, '^%d+$') == nil then
    return false
  end
  return redis.call('EXISTS', 'LiveSnapshotMeta:' .. receipt.season .. ':' .. event_id) == 1
end

for _, key in ipairs(receipt.finalKeys) do
  if not live_snapshot_owns(key) then redis.call('DEL', key) end
end
for _, item in ipairs(receipt.backups) do
  if live_snapshot_owns(item.key) then
    redis.call('DEL', item.backupKey)
  elseif redis.call('EXISTS', item.backupKey) == 1 then
    redis.call('DEL', item.key)
    redis.call('RENAME', item.backupKey, item.key)
  end
end

if ARGV[2] ~= '' and redis.call('EXISTS', ARGV[2]) == 1 then
  local durable_players = cjson.decode(ARGV[3])
  for element_id, player in pairs(durable_players) do
    if redis.call('HEXISTS', ARGV[2], element_id) == 1 then
      redis.call('HSET', ARGV[2], element_id, player)
    end
  end
end

redis.call('DEL', KEYS[2])
if redis.call('EXISTS', receipt.currentEventBackupKey) == 1 then
  redis.call('RENAME', receipt.currentEventBackupKey, KEYS[2])
end
if receipt.previousActiveSeason == cjson.null then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], receipt.previousActiveSeason)
end
redis.call('DEL', KEYS[3])
return {'rolled_back'}
`;

function serializeEvent(event: Event): string {
  return JSON.stringify(event);
}

function fixtureHash(fixtures: Fixture[]): HashFields {
  return Object.fromEntries(
    fixtures.map((fixture) => [String(fixture.id), JSON.stringify(fixture)]),
  );
}

export function buildCoreSnapshotCachePlan(snapshot: CoreSnapshot): CoreSnapshotCachePlan {
  const hashes = new Map<string, HashFields>();
  hashes.set(
    `Event:${snapshot.season}`,
    Object.fromEntries(snapshot.events.map((event) => [String(event.id), serializeEvent(event)])),
  );
  hashes.set(
    `Team:${snapshot.season}`,
    Object.fromEntries(snapshot.teams.map((team) => [String(team.id), JSON.stringify(team)])),
  );
  hashes.set(
    `Player:${snapshot.season}`,
    Object.fromEntries(
      snapshot.players.map((player) => [String(player.id), JSON.stringify(player)]),
    ),
  );
  hashes.set(
    `Phase:${snapshot.season}`,
    Object.fromEntries(snapshot.phases.map((phase) => [String(phase.id), JSON.stringify(phase)])),
  );

  const fixturesByEvent = new Map<number | 'unscheduled', Fixture[]>();
  for (const fixture of snapshot.fixtures) {
    const eventKey = fixture.event ?? 'unscheduled';
    const eventFixtures = fixturesByEvent.get(eventKey) ?? [];
    eventFixtures.push(fixture);
    fixturesByEvent.set(eventKey, eventFixtures);
  }
  for (const [eventId, fixtures] of fixturesByEvent) {
    hashes.set(`Fixtures:${snapshot.season}:${eventId}`, fixtureHash(fixtures));
  }

  const teamById = new Map(
    snapshot.teams.map((team) => [team.id, { name: team.name, shortName: team.shortName }]),
  );
  const fixturesByTeam = buildFixturesByTeam(
    snapshot.teams.map((team) => team.id),
    snapshot.fixtures,
    teamById,
  );
  for (const [teamId, eventMap] of fixturesByTeam) {
    hashes.set(
      `FixturesByTeam:${snapshot.season}:${teamId}`,
      Object.fromEntries(
        [...eventMap].map(([eventId, fixture]) => [String(eventId), JSON.stringify(fixture)]),
      ),
    );
  }

  for (const fields of hashes.values()) {
    if (Object.keys(fields).length === 0) {
      throw new CacheError(
        'Core snapshot cache plan contains an empty hash',
        'CORE_SNAPSHOT_EMPTY_CACHE_HASH',
      );
    }
  }

  const currentEvent = selectCurrentEventByDeadline(snapshot.events);
  return {
    hashes,
    currentEvent: currentEvent ? serializeEvent(currentEvent) : null,
  };
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    keys.push(...found);
    cursor = nextCursor;
  } while (cursor !== '0');
  return keys;
}

async function execChecked(
  command: ReturnType<Redis['pipeline']>,
  code: string,
): Promise<Array<[Error | null, unknown]>> {
  const result = await command.exec();
  if (!result) throw new CacheError('Redis transaction returned no result', code);
  const errors = result.filter(([error]) => error !== null);
  if (errors.length > 0) {
    throw new CacheError('Redis transaction contained command failures', code);
  }
  return result as Array<[Error | null, unknown]>;
}

function isValidSeason(value: string | null): value is string {
  return value !== null && /^\d{4}$/.test(value);
}

function firstResponseValue(result: unknown): string {
  if (!Array.isArray(result) || result.length === 0) return '';
  const value = result[0];
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function responseValue(result: unknown, index: number): string {
  if (!Array.isArray(result) || result.length <= index) return '';
  const value = result[index];
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function fixtureOwnershipMetaKey(key: string, season: string): string | undefined {
  const match = key.match(new RegExp(`^Fixtures:${season}:(\\d+)$`));
  if (!match) return undefined;
  const eventId = Number(match[1]);
  return Number.isInteger(eventId) && eventId > 0
    ? liveSnapshotMetaKey(season, eventId)
    : undefined;
}

function parseReceipt(value: string): CoreSnapshotCachePublicationReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CacheError(
      'Core snapshot pending publication marker is malformed',
      'CORE_SNAPSHOT_PENDING_MARKER_INVALID',
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('publicationId' in parsed) ||
    typeof parsed.publicationId !== 'string' ||
    !('season' in parsed) ||
    typeof parsed.season !== 'string' ||
    !('sourceCheckedAt' in parsed) ||
    typeof parsed.sourceCheckedAt !== 'string' ||
    !('fixtureIds' in parsed) ||
    !Array.isArray(parsed.fixtureIds) ||
    !('finalKeys' in parsed) ||
    !Array.isArray(parsed.finalKeys) ||
    !('backups' in parsed) ||
    !Array.isArray(parsed.backups) ||
    !('currentEventBackupKey' in parsed) ||
    typeof parsed.currentEventBackupKey !== 'string'
  ) {
    throw new CacheError(
      'Core snapshot pending publication marker is incomplete',
      'CORE_SNAPSHOT_PENDING_MARKER_INVALID',
    );
  }
  const receipt = parsed as CoreSnapshotCachePublicationReceipt;
  const publicationPrefix = `CoreSnapshotBackup:${receipt.season}:${receipt.publicationId}:`;
  const validCoreKey = (key: string) =>
    [
      `Event:${receipt.season}`,
      `Team:${receipt.season}`,
      `Player:${receipt.season}`,
      `Phase:${receipt.season}`,
    ].includes(key) ||
    key.startsWith(`Fixtures:${receipt.season}:`) ||
    key.startsWith(`FixturesByTeam:${receipt.season}:`);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      receipt.publicationId,
    ) ||
    !isValidSeason(receipt.season) ||
    Number.isNaN(Date.parse(receipt.sourceCheckedAt)) ||
    receipt.fixtureIds.length > 500 ||
    receipt.fixtureIds.some((id) => !Number.isInteger(id) || id <= 0) ||
    new Set(receipt.fixtureIds).size !== receipt.fixtureIds.length ||
    (receipt.previousActiveSeason !== null && !isValidSeason(receipt.previousActiveSeason)) ||
    receipt.finalKeys.some((key) => typeof key !== 'string' || !validCoreKey(key)) ||
    receipt.backups.some(
      (item) =>
        !item ||
        typeof item.key !== 'string' ||
        typeof item.backupKey !== 'string' ||
        !validCoreKey(item.key) ||
        !item.backupKey.startsWith(publicationPrefix),
    ) ||
    !receipt.currentEventBackupKey.startsWith(publicationPrefix)
  ) {
    throw new CacheError(
      'Core snapshot pending publication marker contains unsafe keys',
      'CORE_SNAPSHOT_PENDING_MARKER_INVALID',
    );
  }
  return receipt;
}

export async function publishCoreSnapshotCache(
  snapshot: CoreSnapshot,
  options: PublishOptions = {},
): Promise<CoreSnapshotCachePublication> {
  const redis = options.redis ?? (await redisSingleton.getClient());
  const current = await redis.get(ACTIVE_SEASON_KEY);
  if (current !== null && !isValidSeason(current)) {
    throw new CacheError('Active cache season is malformed', 'CORE_SNAPSHOT_ACTIVE_SEASON_INVALID');
  }
  if (isValidSeason(current) && isNewerSeason(current, snapshot.season)) {
    return { published: false, reason: 'newer_active_season', hashCount: 0 };
  }

  const plan = buildCoreSnapshotCachePlan(snapshot);
  const token = options.publicationId ?? randomUUID();
  const staged = new Map<string, string>(
    [...plan.hashes.keys()].map((finalKey, index) => [
      finalKey,
      `CoreSnapshotStage:${snapshot.season}:${token}:${index}`,
    ]),
  );
  const stagingKeys = [...staged.values()];

  try {
    const stage = redis.pipeline();
    for (const [finalKey, fields] of plan.hashes) {
      stage.hset(staged.get(finalKey)!, fields);
      stage.pexpire(staged.get(finalKey)!, CORE_SNAPSHOT_STAGING_TTL_MS);
    }
    await execChecked(stage, 'CORE_SNAPSHOT_STAGE_FAILED');

    const verify = redis.pipeline();
    for (const stagingKey of stagingKeys) verify.hlen(stagingKey);
    const verified = await execChecked(verify, 'CORE_SNAPSHOT_STAGE_VERIFY_FAILED');
    const expectedCounts = [...plan.hashes.values()].map((fields) => Object.keys(fields).length);
    verified.forEach(([, count], index) => {
      if (Number(count) !== expectedCounts[index]) {
        throw new CacheError(
          'Core snapshot staged hash count mismatch',
          'CORE_SNAPSHOT_STAGE_INCOMPLETE',
        );
      }
    });

    await options.afterStage?.();

    const latest = await redis.get(ACTIVE_SEASON_KEY);
    if (isValidSeason(latest) && isNewerSeason(latest, snapshot.season)) {
      return { published: false, reason: 'newer_active_season', hashCount: 0 };
    }

    const [existingFixtures, existingTeamFixtures] = await Promise.all([
      scanKeys(redis, `Fixtures:${snapshot.season}:*`),
      scanKeys(redis, `FixturesByTeam:${snapshot.season}:*`),
    ]);
    const targetKeys = [
      ...new Set([...plan.hashes.keys(), ...existingFixtures, ...existingTeamFixtures]),
    ];
    const backups = targetKeys.map((key, index) => ({
      key,
      backupKey: `CoreSnapshotBackup:${snapshot.season}:${token}:${index}`,
    }));
    const currentEventBackupKey = `CoreSnapshotBackup:${snapshot.season}:${token}:current-event`;
    const response = await redis.eval(
      PUBLISH_SCRIPT,
      3,
      ACTIVE_SEASON_KEY,
      'event:current',
      CORE_SNAPSHOT_PENDING_PUBLICATION_KEY,
      JSON.stringify({
        expectedActive: current ?? '',
        season: snapshot.season,
        currentEvent: plan.currentEvent,
        staged: [...staged].map(([finalKey, stageKey], index) => ({
          finalKey,
          stageKey,
          expectedCount: expectedCounts[index],
          ...(fixtureOwnershipMetaKey(finalKey, snapshot.season)
            ? { metaKey: fixtureOwnershipMetaKey(finalKey, snapshot.season) }
            : {}),
        })),
        backups: backups.map((backup) => ({
          ...backup,
          ...(fixtureOwnershipMetaKey(backup.key, snapshot.season)
            ? { metaKey: fixtureOwnershipMetaKey(backup.key, snapshot.season) }
            : {}),
        })),
        publicationId: token,
        sourceCheckedAt: (options.sourceCheckedAt ?? new Date(0)).toISOString(),
        fixtureIds: snapshot.fixtures.map((fixture) => fixture.id),
        previousActiveSeason: current,
        currentEventBackupKey,
      }),
    );
    const status = firstResponseValue(response);
    if (status === 'authority_changed') {
      return { published: false, reason: 'newer_active_season', hashCount: 0 };
    }
    if (status !== 'published') {
      throw new CacheError(
        'Core snapshot cache publication precondition failed',
        status === 'pending_publication'
          ? 'CORE_SNAPSHOT_PENDING_PUBLICATION'
          : 'CORE_SNAPSHOT_PUBLICATION_FAILED',
      );
    }

    const receipt = parseReceipt(responseValue(response, 2));

    return {
      published: true,
      reason: 'published',
      hashCount: receipt.finalKeys.length,
      receipt,
    };
  } finally {
    if (stagingKeys.length > 0) {
      await redis.del(...stagingKeys).catch((error) => {
        logWarn('Failed to remove core snapshot staging keys', {
          error: error instanceof Error ? error.message : String(error),
          count: stagingKeys.length,
        });
      });
    }
  }
}

export async function readPendingCoreSnapshotCachePublication(
  redisClient?: Redis,
): Promise<CoreSnapshotCachePublicationReceipt | null> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const value = await redis.get(CORE_SNAPSHOT_PENDING_PUBLICATION_KEY);
  return value ? parseReceipt(value) : null;
}

export async function finalizeCoreSnapshotCachePublication(
  receipt: CoreSnapshotCachePublicationReceipt,
  redisClient?: Redis,
): Promise<void> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const response = await redis.eval(
    FINALIZE_SCRIPT,
    1,
    CORE_SNAPSHOT_PENDING_PUBLICATION_KEY,
    JSON.stringify(receipt),
  );
  const status = firstResponseValue(response);
  if (status === 'different_publication') {
    throw new CacheError(
      'A different core snapshot publication is pending',
      'CORE_SNAPSHOT_PUBLICATION_AUTHORITY_MISMATCH',
    );
  }
  const activeSeason = await redis.get(ACTIVE_SEASON_KEY);
  if (activeSeason === receipt.season) rememberCoreSnapshotActiveSeason(receipt.season);
  else resetActiveSeasonMemo();
}

export async function rollbackCoreSnapshotCachePublication(
  receipt: CoreSnapshotCachePublicationReceipt,
  redisClient?: Redis,
  durablePlayers?: readonly Player[],
): Promise<void> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const playerKey = durablePlayers && durablePlayers.length > 0 ? `Player:${receipt.season}` : '';
  const playerHash = Object.fromEntries(
    (durablePlayers ?? []).map((player) => [String(player.id), JSON.stringify(player)]),
  );
  const response = await redis.eval(
    ROLLBACK_SCRIPT,
    3,
    ACTIVE_SEASON_KEY,
    'event:current',
    CORE_SNAPSHOT_PENDING_PUBLICATION_KEY,
    JSON.stringify(receipt),
    playerKey,
    JSON.stringify(playerHash),
  );
  if (firstResponseValue(response) === 'different_publication') {
    throw new CacheError(
      'A different core snapshot publication is pending',
      'CORE_SNAPSHOT_PUBLICATION_AUTHORITY_MISMATCH',
    );
  }
  resetActiveSeasonMemo();
}
