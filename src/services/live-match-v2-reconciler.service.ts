import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';

import {
  clearLiveMatchCheckpointDesiredV2,
  LIVE_MATCHES_REDIS_PREFIX,
  markLiveMatchDeskCheckpointedV2,
  markLiveMatchDetailCheckpointedV2,
  readLiveMatchCheckpointDesiredV2,
  readLiveMatchDeskV2,
  readLiveMatchDetailV2,
  setLiveMatchCheckpointDesiredV2,
  type MatchCheckpointDesired,
  type MatchDeskPublication,
  type MatchDetailPublication,
} from '../cache/live-match-publication-v2';
import { redisSingleton } from '../cache/singleton';
import {
  liveMatchDeskCheckpointsInFpl,
  liveMatchDetailCheckpointsInFpl,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { enqueueLiveMatchCheckpoint } from '../jobs/live-data.jobs';
import { logWarn } from '../utils/logger';

type MatchCheckpointKind = 'desk' | 'detail';
type MatchPublication = MatchDeskPublication | MatchDetailPublication;

export type LiveMatchCheckpointScope = Readonly<{
  eventId: number;
  kind: MatchCheckpointKind;
}>;

export type LiveMatchCheckpointHead = Readonly<{
  publicationId: string;
  generation: number;
  checkpointedAt: Date;
}>;

type LiveMatchCurrent = Readonly<{
  publication: MatchPublication;
}>;

export type LiveMatchCheckpointReconcileResult = Readonly<{
  eventId: number;
  kind: MatchCheckpointKind;
  status: 'matched' | 'enqueued' | 'missing-current' | 'blocked-final' | 'changed' | 'failed';
  publicationId?: string;
  generation?: number;
}>;

export type LiveMatchCheckpointReconcilerDependencies = Readonly<{
  listScopes: (season: string) => Promise<readonly LiveMatchCheckpointScope[]>;
  readHeads: (season: FplSeasonRef) => Promise<ReadonlyMap<string, LiveMatchCheckpointHead>>;
  readCurrent: (
    season: string,
    eventId: number,
    kind: MatchCheckpointKind,
  ) => Promise<LiveMatchCurrent | null>;
  readDesired: (
    season: string,
    eventId: number,
    kind: MatchCheckpointKind,
  ) => Promise<MatchCheckpointDesired | null>;
  setDesired: (
    kind: MatchCheckpointKind,
    publication: MatchPublication,
  ) => Promise<MatchCheckpointDesired>;
  markCheckpointed: (
    kind: MatchCheckpointKind,
    publication: MatchPublication,
    checkpointedAt: Date,
  ) => Promise<MatchPublication | null>;
  clearDesired: (desired: MatchCheckpointDesired) => Promise<void>;
  enqueue: (
    season: FplSeasonRef,
    eventId: number,
    kind: MatchCheckpointKind,
    publicationId: string,
    generation: number,
  ) => Promise<unknown>;
}>;

const scopeKey = (eventId: number, kind: MatchCheckpointKind): string => `${eventId}:${kind}`;

const sameIdentity = (
  left: Pick<MatchCheckpointDesired, 'publicationId' | 'generation'>,
  right: Pick<MatchPublication, 'publicationId' | 'generation'>,
): boolean => left.publicationId === right.publicationId && left.generation === right.generation;

const finalPublication = (kind: MatchCheckpointKind, publication: MatchPublication): boolean =>
  kind === 'desk'
    ? 'state' in publication && publication.state === 'FINALIZED'
    : 'finalized' in publication && publication.finalized === true;

async function scanKeys(redis: Redis, pattern: string): Promise<readonly string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...found);
    if (keys.length > 256) {
      throw new Error(`Live Match checkpoint scope scan exceeded 256 keys for ${pattern}`);
    }
  } while (cursor !== '0');
  return keys;
}

async function listRedisScopes(season: string): Promise<readonly LiveMatchCheckpointScope[]> {
  if (!/^\d{4}$/.test(season)) throw new Error('Live Match reconciler season is invalid');
  const redis = await redisSingleton.getClient();
  const keys = (
    await Promise.all([
      scanKeys(redis, `${LIVE_MATCHES_REDIS_PREFIX}:desk:${season}:*:active`),
      scanKeys(redis, `${LIVE_MATCHES_REDIS_PREFIX}:detail:${season}:*:active`),
      scanKeys(redis, `${LIVE_MATCHES_REDIS_PREFIX}:checkpoint:${season}:*:*`),
    ])
  ).flat();
  const scopes = new Map<string, LiveMatchCheckpointScope>();
  const activePattern =
    /^llm:data:v2:fpl:live-match:(desk|detail):(\d{4}):([1-9][0-9]*):active$/;
  const desiredPattern =
    /^llm:data:v2:fpl:live-match:checkpoint:(\d{4}):([1-9][0-9]*):(desk|detail)$/;
  for (const key of keys) {
    const active = activePattern.exec(key);
    if (active?.[2] === season) {
      const kind = active[1] as MatchCheckpointKind;
      const eventId = Number(active[3]);
      scopes.set(scopeKey(eventId, kind), { eventId, kind });
      continue;
    }
    const desired = desiredPattern.exec(key);
    if (desired?.[1] === season) {
      const eventId = Number(desired[2]);
      const kind = desired[3] as MatchCheckpointKind;
      scopes.set(scopeKey(eventId, kind), { eventId, kind });
    }
  }
  if (scopes.size > 80) throw new Error('Live Match checkpoint reconciler exceeded 80 scopes');
  return [...scopes.values()].sort(
    (left, right) => left.eventId - right.eventId || left.kind.localeCompare(right.kind),
  );
}

async function readCheckpointHeads(
  season: FplSeasonRef,
): Promise<ReadonlyMap<string, LiveMatchCheckpointHead>> {
  const db = await getDb();
  const [deskRows, detailRows] = await Promise.all([
    db
      .select({
        eventId: liveMatchDeskCheckpointsInFpl.eventId,
        publicationId: liveMatchDeskCheckpointsInFpl.publicationId,
        generation: liveMatchDeskCheckpointsInFpl.generation,
        checkpointedAt: liveMatchDeskCheckpointsInFpl.checkpointedAt,
      })
      .from(liveMatchDeskCheckpointsInFpl)
      .where(eq(liveMatchDeskCheckpointsInFpl.seasonId, season.seasonId)),
    db
      .select({
        eventId: liveMatchDetailCheckpointsInFpl.eventId,
        publicationId: liveMatchDetailCheckpointsInFpl.publicationId,
        generation: liveMatchDetailCheckpointsInFpl.generation,
        checkpointedAt: liveMatchDetailCheckpointsInFpl.checkpointedAt,
      })
      .from(liveMatchDetailCheckpointsInFpl)
      .where(eq(liveMatchDetailCheckpointsInFpl.seasonId, season.seasonId)),
  ]);
  const heads = new Map<string, LiveMatchCheckpointHead>();
  for (const [kind, rows] of [
    ['desk', deskRows],
    ['detail', detailRows],
  ] as const) {
    for (const row of rows) {
      heads.set(scopeKey(row.eventId, kind), {
        publicationId: row.publicationId,
        generation: row.generation,
        checkpointedAt: row.checkpointedAt,
      });
    }
  }
  return heads;
}

const defaultDependencies: LiveMatchCheckpointReconcilerDependencies = {
  listScopes: listRedisScopes,
  readHeads: readCheckpointHeads,
  readCurrent: async (season, eventId, kind) => {
    const current =
      kind === 'desk'
        ? await readLiveMatchDeskV2({ season, eventId })
        : await readLiveMatchDetailV2({ season, eventId });
    return current?.servedFrom === 'REDIS_CURRENT' ? { publication: current.publication } : null;
  },
  readDesired: (season, eventId, kind) =>
    readLiveMatchCheckpointDesiredV2({ season, eventId, kind }),
  setDesired: (kind, publication) =>
    setLiveMatchCheckpointDesiredV2({
      kind,
      publication,
      finalized: finalPublication(kind, publication),
    }),
  markCheckpointed: async (kind, publication, checkpointedAt) =>
    kind === 'desk'
      ? markLiveMatchDeskCheckpointedV2(
          publication as MatchDeskPublication,
          checkpointedAt,
        )
      : markLiveMatchDetailCheckpointedV2(
          publication as MatchDetailPublication,
          checkpointedAt,
        ),
  clearDesired: clearLiveMatchCheckpointDesiredV2,
  enqueue: enqueueLiveMatchCheckpoint,
};

/**
 * Provider-independent recovery for Redis-first Match checkpoints. Every pass
 * discovers exact active/desired scopes, compares them with the durable head,
 * and either closes the exact CAS receipt or re-enqueues the latest marker.
 */
export async function reconcileLiveMatchCheckpointObligationsV2(
  season: FplSeasonRef,
  overrides: Partial<LiveMatchCheckpointReconcilerDependencies> = {},
): Promise<readonly LiveMatchCheckpointReconcileResult[]> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const [scopes, heads] = await Promise.all([
    dependencies.listScopes(season.seasonCode),
    dependencies.readHeads(season),
  ]);
  const results: LiveMatchCheckpointReconcileResult[] = [];
  for (const scope of scopes) {
    try {
      const [current, existingDesired] = await Promise.all([
        dependencies.readCurrent(season.seasonCode, scope.eventId, scope.kind),
        dependencies.readDesired(season.seasonCode, scope.eventId, scope.kind),
      ]);
      if (!current) {
        results.push({ ...scope, status: 'missing-current' });
        continue;
      }
      const publication = current.publication;
      if (
        existingDesired?.final === true &&
        !sameIdentity(existingDesired, publication)
      ) {
        results.push({
          ...scope,
          status: 'blocked-final',
          publicationId: existingDesired.publicationId,
          generation: existingDesired.generation,
        });
        continue;
      }
      let desired = existingDesired;
      if (!desired || !sameIdentity(desired, publication)) {
        desired = await dependencies.setDesired(scope.kind, publication);
      }
      if (!sameIdentity(desired, publication)) {
        results.push({
          ...scope,
          status: desired.final ? 'blocked-final' : 'changed',
          publicationId: desired.publicationId,
          generation: desired.generation,
        });
        continue;
      }
      const head = heads.get(scopeKey(scope.eventId, scope.kind));
      if (head && sameIdentity(head, publication)) {
        if (publication.checkpointedAt === null) {
          const marked = await dependencies.markCheckpointed(
            scope.kind,
            publication,
            head.checkpointedAt,
          );
          if (!marked) {
            results.push({
              ...scope,
              status: 'changed',
              publicationId: publication.publicationId,
              generation: publication.generation,
            });
            continue;
          }
        }
        await dependencies.clearDesired(desired);
        results.push({
          ...scope,
          status: 'matched',
          publicationId: publication.publicationId,
          generation: publication.generation,
        });
        continue;
      }
      await dependencies.enqueue(
        season,
        scope.eventId,
        scope.kind,
        desired.publicationId,
        desired.generation,
      );
      results.push({
        ...scope,
        status: 'enqueued',
        publicationId: desired.publicationId,
        generation: desired.generation,
      });
    } catch (error) {
      logWarn('Live Match checkpoint reconciliation failed for scope', {
        season: season.seasonCode,
        eventId: scope.eventId,
        kind: scope.kind,
        error: error instanceof Error ? error.message : 'unknown',
      });
      results.push({ ...scope, status: 'failed' });
    }
  }
  return results;
}
