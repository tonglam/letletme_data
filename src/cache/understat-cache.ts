import type Redis from 'ioredis';

import type {
  createUnderstatPlayerRepository,
  createUnderstatTeamRepository,
} from '../repositories/understat';
import { getConfig } from '../utils/config';
import { logInfo } from '../utils/logger';
import { understatRedisSingleton } from './singleton';

export const UNDERSTAT_ACTIVE_SEASON_KEY = 'Understat:Season:active';
export const UNDERSTAT_EMPTY_HASH_FIELD = '__empty__';
const STAGING_TTL_SECONDS = 60 * 60;
const RETIRED_TTL_SECONDS = 24 * 60 * 60;
const MAX_GENERATION_HSET_BYTES = 512 * 1024;

type TeamSnapshot = Awaited<
  ReturnType<ReturnType<typeof createUnderstatTeamRepository>['readSnapshot']>
>;
type PlayerSnapshot = Awaited<
  ReturnType<ReturnType<typeof createUnderstatPlayerRepository>['readSnapshot']>
>;

export interface UnderstatSnapshotManifest {
  schemaVersion: 1;
  season: string;
  lane: 'team' | 'player';
  revision: string;
  publishedAt: string;
  counts: Record<string, number>;
}

function manifestKey(season: string, lane: 'team' | 'player'): string {
  return `Understat:Snapshot:${season}:${lane}`;
}

function teamKeys(season: string, revision: string): string[] {
  return [
    `Understat:Team:${season}:${revision}`,
    `Understat:Match:${season}:${revision}`,
    `Understat:TeamMatches:${season}:${revision}`,
    `Understat:TeamSplits:${season}:${revision}`,
  ];
}

function playerKeys(season: string, revision: string): string[] {
  return [
    `Understat:Player:${season}:${revision}`,
    `Understat:TeamParticipants:${season}:${revision}`,
    `Understat:PlayerMatches:${season}:${revision}`,
  ];
}

function hashFromEntries(entries: Array<[string, unknown]>): Record<string, string> {
  return Object.fromEntries(entries.map(([field, value]) => [field, JSON.stringify(value)]));
}

function splitHash(hash: Record<string, string>): Record<string, string>[] {
  const encoder = new TextEncoder();
  const batches: Record<string, string>[] = [];
  let current: Array<[string, string]> = [];
  let currentBytes = 0;

  for (const entry of Object.entries(hash)) {
    const entryBytes = encoder.encode(entry[0]).byteLength + encoder.encode(entry[1]).byteLength;
    if (current.length > 0 && currentBytes + entryBytes > MAX_GENERATION_HSET_BYTES) {
      batches.push(Object.fromEntries(current));
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entryBytes;
  }

  if (current.length > 0) batches.push(Object.fromEntries(current));
  return batches;
}

function groupById<T>(rows: T[], id: (row: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const key = id(row);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  return grouped;
}

async function setGenerationHashes(
  redis: Redis,
  keys: string[],
  hashes: Record<string, string>[],
): Promise<void> {
  const materializedHashes = hashes.map((sourceHash) =>
    Object.keys(sourceHash).length > 0
      ? sourceHash
      : { [UNDERSTAT_EMPTY_HASH_FIELD]: JSON.stringify([]) },
  );
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const hash = materializedHashes[index];
    const clearPipeline = redis.pipeline();
    clearPipeline.del(key);
    let results = await clearPipeline.exec();
    let error = results?.find(([candidate]) => candidate !== null)?.[0];
    if (error) throw error;

    for (const batch of splitHash(hash)) {
      const writePipeline = redis.pipeline();
      writePipeline.hset(key, batch);
      results = await writePipeline.exec();
      error = results?.find(([candidate]) => candidate !== null)?.[0];
      if (error) throw error;
    }

    const ttlPipeline = redis.pipeline();
    ttlPipeline.expire(key, STAGING_TTL_SECONDS);
    results = await ttlPipeline.exec();
    error = results?.find(([candidate]) => candidate !== null)?.[0];
    if (error) throw error;
  }

  const counts = await Promise.all(keys.map((key) => redis.hlen(key)));
  for (let index = 0; index < keys.length; index += 1) {
    if (counts[index] !== Object.keys(materializedHashes[index]).length) {
      throw new Error(
        `Incomplete Understat generation hash ${keys[index]}: expected=${Object.keys(materializedHashes[index]).length} actual=${counts[index]}`,
      );
    }
  }
}

function parseManifest(raw: string | null): UnderstatSnapshotManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UnderstatSnapshotManifest>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.season !== 'string' ||
      (value.lane !== 'team' && value.lane !== 'player') ||
      typeof value.revision !== 'string' ||
      typeof value.publishedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.publishedAt))
    ) {
      return null;
    }
    return value as UnderstatSnapshotManifest;
  } catch {
    return null;
  }
}

async function commitGeneration(
  redis: Redis,
  manifest: UnderstatSnapshotManifest,
  newKeys: string[],
  priorKeys: string[],
  updateActiveSeason: boolean,
): Promise<void> {
  const transaction = redis.multi();
  if (updateActiveSeason) transaction.set(UNDERSTAT_ACTIVE_SEASON_KEY, manifest.season);
  transaction.set(manifestKey(manifest.season, manifest.lane), JSON.stringify(manifest));
  for (const key of newKeys) transaction.persist(key);
  for (const key of priorKeys) transaction.expire(key, RETIRED_TTL_SECONDS);
  const results = await transaction.exec();
  if (!results) throw new Error('Understat cache publication transaction aborted');
  const error = results.find(([candidate]) => candidate !== null)?.[0];
  if (error) throw error;
}

type UnderstatCacheDependencies = {
  getRedisClient: () => Promise<Redis>;
  getActiveSeason?: () => string;
};

export function createUnderstatCache(dependencies: UnderstatCacheDependencies) {
  return {
    async getManifest(
      season: string,
      lane: 'team' | 'player',
    ): Promise<UnderstatSnapshotManifest | null> {
      const redis = await dependencies.getRedisClient();
      return parseManifest(await redis.get(manifestKey(season, lane)));
    },

    async publishTeam(
      season: string,
      revision: string,
      snapshot: TeamSnapshot,
    ): Promise<UnderstatSnapshotManifest> {
      const redis = await dependencies.getRedisClient();
      const prior = parseManifest(await redis.get(manifestKey(season, 'team')));
      if (prior?.revision === revision) return prior;
      const keys = teamKeys(season, revision);
      const teamMatches = groupById(snapshot.teamMatchRows, (row) => row.stat.teamId);
      const splits = groupById(snapshot.splits, (row) => row.teamId);
      const hashes = [
        hashFromEntries(snapshot.teams.map((row) => [String(row.team.id), row])),
        hashFromEntries(snapshot.matches.map((row) => [String(row.id), row])),
        hashFromEntries([...teamMatches].map(([teamId, rows]) => [String(teamId), rows])),
        hashFromEntries([...splits].map(([teamId, rows]) => [String(teamId), rows])),
      ];
      await setGenerationHashes(redis, keys, hashes);
      const manifest: UnderstatSnapshotManifest = {
        schemaVersion: 1,
        season,
        lane: 'team',
        revision,
        publishedAt: new Date().toISOString(),
        counts: {
          teams: snapshot.teams.length,
          matches: snapshot.matches.length,
          teamMatches: snapshot.teamMatchRows.length,
          splits: snapshot.splits.length,
        },
      };
      await commitGeneration(
        redis,
        manifest,
        keys,
        prior ? teamKeys(season, prior.revision) : [],
        !dependencies.getActiveSeason || dependencies.getActiveSeason() === season,
      );
      logInfo('Understat team cache snapshot published', manifest);
      return manifest;
    },

    async publishPlayer(
      season: string,
      revision: string,
      snapshot: PlayerSnapshot,
    ): Promise<UnderstatSnapshotManifest> {
      const redis = await dependencies.getRedisClient();
      const prior = parseManifest(await redis.get(manifestKey(season, 'player')));
      if (prior?.revision === revision) return prior;
      const keys = playerKeys(season, revision);
      const membershipsByPlayer = groupById(snapshot.memberships, (row) => row.playerId);
      const membershipsByTeam = groupById(snapshot.memberships, (row) => row.teamId);
      const matchStatsByPlayer = groupById(snapshot.matchStats, (row) => row.stat.playerId);
      const playerById = new Map(snapshot.players.map((row) => [row.player.id, row.player]));
      const hashes = [
        hashFromEntries(
          snapshot.players.map((row) => [
            String(row.player.id),
            { ...row, memberships: membershipsByPlayer.get(row.player.id) ?? [] },
          ]),
        ),
        hashFromEntries(
          [...membershipsByTeam].map(([teamId, rows]) => [
            String(teamId),
            rows.map((row) => ({ ...row, player: playerById.get(row.playerId) ?? null })),
          ]),
        ),
        hashFromEntries(
          [...matchStatsByPlayer].map(([playerId, rows]) => [String(playerId), rows]),
        ),
      ];
      await setGenerationHashes(redis, keys, hashes);
      const manifest: UnderstatSnapshotManifest = {
        schemaVersion: 1,
        season,
        lane: 'player',
        revision,
        publishedAt: new Date().toISOString(),
        counts: {
          players: snapshot.players.length,
          memberships: snapshot.memberships.length,
          playerMatches: snapshot.matchStats.length,
        },
      };
      await commitGeneration(
        redis,
        manifest,
        keys,
        prior ? playerKeys(season, prior.revision) : [],
        !dependencies.getActiveSeason || dependencies.getActiveSeason() === season,
      );
      logInfo('Understat player cache snapshot published', manifest);
      return manifest;
    },
  };
}

export const understatCache = createUnderstatCache({
  getRedisClient: () => understatRedisSingleton.getClient(),
  getActiveSeason: () => getConfig().UNDERSTAT_SEASON,
});
