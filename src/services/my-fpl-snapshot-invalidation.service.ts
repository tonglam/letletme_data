import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type Redis from 'ioredis';

import { redisSingleton } from '../cache/singleton';
import { getDbClient } from '../db/singleton';
import { logInfo, logWarn } from '../utils/logger';
import { myFplSnapshotRedisManifestKey } from './my-fpl-snapshot-publication.service';
import {
  isSupportedMyFplInvalidationReason,
  parseMyFplSnapshotInvalidationResult,
} from '../domain/my-fpl-invalidation';
import { myFplSnapshotEventLockScope } from '../domain/my-fpl-locks';

export {
  MY_FPL_SNAPSHOT_INVALIDATION_REASON,
  parseMyFplSnapshotInvalidationResult,
} from '../domain/my-fpl-invalidation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type { MyFplSnapshotInvalidationStatus } from '../domain/my-fpl-invalidation';

export type MyFplSnapshotInvalidationOutboxDispatchResult = Readonly<{
  claimed: number;
  delivered: number;
  superseded: number;
  failed: number;
  remaining: number;
}>;

export type MyFplSnapshotInvalidationDispatchOptions = Readonly<{
  limit?: number;
  seasonId?: number;
  eventId?: number;
  tournamentId?: number;
  outboxIds?: readonly string[];
}>;

type InvalidationOutboxRow = {
  outbox_id: string;
  season_id: number;
  event_id: number;
  revision: number | string;
  tournament_id: number;
  reason: string;
  season_code: string;
};

export type InvalidationOutboxDependencies = Readonly<{
  getDbClient?: () => Promise<postgres.Sql>;
  getRedisClient?: () => Promise<Redis>;
  makeOwner?: () => string;
}>;

/**
 * Compare and delete one My FPL manifest without deleting a newer revision.
 * A malformed manifest is not a usable publication pointer and is therefore
 * deleted so the consumer fails closed until PostgreSQL is rebuilt.
 */
export const MY_FPL_SNAPSHOT_INVALIDATE_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
if not current_raw then
  return {'absent'}
end
local decoded, current = pcall(cjson.decode, current_raw)
if not decoded or type(current) ~= 'table' or tonumber(current.revision) == nil then
  redis.call('DEL', KEYS[1])
  return {'malformed_deleted'}
end
if tonumber(current.revision) ~= tonumber(ARGV[1]) then
  return {'different'}
end
redis.call('DEL', KEYS[1])
return {'deleted'}
`;

function validateOptions(options: MyFplSnapshotInvalidationDispatchOptions): {
  limit: number;
  outboxIds?: readonly string[];
} {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('My FPL invalidation outbox limit must be between 1 and 100');
  }
  if (options.outboxIds === undefined) return { limit };
  if (options.outboxIds.some((id) => !UUID_RE.test(id))) {
    throw new Error('My FPL invalidation outbox IDs must be UUIDs');
  }
  return { limit, outboxIds: options.outboxIds };
}

async function releaseClaim(
  tx: postgres.TransactionSql,
  outboxId: string,
  owner: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await tx`
    UPDATE competition.my_fpl_snapshot_invalidation_outbox
    SET status = 'FAILED',
        available_at = clock_timestamp() + interval '5 minutes',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = ${message.slice(0, 4000)},
        updated_at = clock_timestamp()
    WHERE outbox_id = ${outboxId}::uuid AND lease_owner = ${owner}
  `;
}

async function countRemaining(
  db: postgres.Sql,
  options: MyFplSnapshotInvalidationDispatchOptions,
): Promise<number> {
  const outboxIds = options.outboxIds;
  const rows = await db<{ count: number | string }[]>`
    SELECT count(*)::integer AS count
    FROM competition.my_fpl_snapshot_invalidation_outbox outbox
    WHERE outbox.status IN ('PENDING', 'PROCESSING', 'FAILED')
      ${options.seasonId === undefined ? db`` : db`AND outbox.season_id = ${options.seasonId}`}
      ${options.eventId === undefined ? db`` : db`AND outbox.event_id = ${options.eventId}`}
      ${options.tournamentId === undefined ? db`` : db`AND outbox.tournament_id = ${options.tournamentId}`}
      ${outboxIds === undefined ? db`` : db`AND outbox.outbox_id = ANY(${outboxIds}::uuid[])`}
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Deliver durable tournament-deletion tombstones to Redis.  The PostgreSQL
 * row is claimed first, then a two-minute lease protects the Redis CAS and
 * delivery receipt.  A Redis failure is persisted as FAILED with a five
 * minute retry delay; callers may safely return the committed database result.
 */
export function createMyFplSnapshotInvalidationDispatcher(
  dependencies: InvalidationOutboxDependencies = {},
): (
  options?: MyFplSnapshotInvalidationDispatchOptions,
) => Promise<MyFplSnapshotInvalidationOutboxDispatchResult> {
  const dbFactory = dependencies.getDbClient ?? getDbClient;
  const redisFactory = dependencies.getRedisClient ?? (() => redisSingleton.getClient());
  const ownerFactory = dependencies.makeOwner ?? randomUUID;

  return async (
    options: MyFplSnapshotInvalidationDispatchOptions = {},
  ): Promise<MyFplSnapshotInvalidationOutboxDispatchResult> => {
    const validated = validateOptions(options);
    if (validated.outboxIds?.length === 0) {
      return { claimed: 0, delivered: 0, superseded: 0, failed: 0, remaining: 0 };
    }

    const owner = ownerFactory();
    const db = await dbFactory();
    const claimed = await db.begin(async (tx) => {
      // A worker that died while holding a lease is eligible again.  FAILED is
      // intentionally used as the recoverable terminal state so operations
      // can see the last error while the next claim remains deterministic.
      await tx`
        UPDATE competition.my_fpl_snapshot_invalidation_outbox outbox
        SET status = 'FAILED',
            available_at = clock_timestamp(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = COALESCE(last_error, 'invalidation lease expired'),
            updated_at = clock_timestamp()
        WHERE outbox.status = 'PROCESSING'
          AND outbox.lease_expires_at IS NOT NULL
          AND outbox.lease_expires_at <= clock_timestamp()
          ${options.seasonId === undefined ? tx`` : tx`AND outbox.season_id = ${options.seasonId}`}
          ${options.eventId === undefined ? tx`` : tx`AND outbox.event_id = ${options.eventId}`}
          ${options.tournamentId === undefined ? tx`` : tx`AND outbox.tournament_id = ${options.tournamentId}`}
          ${validated.outboxIds === undefined ? tx`` : tx`AND outbox.outbox_id = ANY(${validated.outboxIds}::uuid[])`}
      `;
      const rows = await tx<InvalidationOutboxRow[]>`
        SELECT outbox.outbox_id, outbox.season_id, outbox.event_id,
               outbox.revision, outbox.tournament_id, outbox.reason,
               season.season_code
        FROM competition.my_fpl_snapshot_invalidation_outbox outbox
        JOIN fpl.seasons season ON season.season_id = outbox.season_id
        WHERE outbox.status IN ('PENDING', 'FAILED')
          AND outbox.available_at <= clock_timestamp()
          ${options.seasonId === undefined ? tx`` : tx`AND outbox.season_id = ${options.seasonId}`}
          ${options.eventId === undefined ? tx`` : tx`AND outbox.event_id = ${options.eventId}`}
          ${options.tournamentId === undefined ? tx`` : tx`AND outbox.tournament_id = ${options.tournamentId}`}
          ${validated.outboxIds === undefined ? tx`` : tx`AND outbox.outbox_id = ANY(${validated.outboxIds}::uuid[])`}
        ORDER BY outbox.available_at, outbox.outbox_id
        LIMIT ${validated.limit}
        FOR UPDATE OF outbox SKIP LOCKED
      `;
      for (const row of rows) {
        await tx`
          UPDATE competition.my_fpl_snapshot_invalidation_outbox
          SET status = 'PROCESSING',
              attempts = attempts + 1,
              lease_owner = ${owner},
              lease_expires_at = clock_timestamp() + interval '2 minutes',
              updated_at = clock_timestamp()
          WHERE outbox_id = ${row.outbox_id}::uuid
        `;
      }
      return rows;
    });

    if (claimed.length === 0) {
      return {
        claimed: 0,
        delivered: 0,
        superseded: 0,
        failed: 0,
        remaining: await countRemaining(db, options),
      };
    }

    let delivered = 0;
    let superseded = 0;
    let failed = 0;
    let redis: Redis | null = null;
    try {
      redis = await redisFactory();
    } catch (error) {
      // Keep every claimed row durable when Redis is unavailable before the
      // first CAS.  This path is deliberately non-throwing for delete callers.
      for (const row of claimed) {
        failed += 1;
        await db.begin((tx) => releaseClaim(tx, row.outbox_id, owner, error));
      }
      return {
        claimed: claimed.length,
        delivered,
        superseded,
        failed,
        remaining: await countRemaining(db, options),
      };
    }

    for (const row of claimed) {
      try {
        if (!isSupportedMyFplInvalidationReason(row.reason)) {
          throw new Error(`Unsupported My FPL invalidation reason ${row.reason}`);
        }
        const status = await db.begin(async (tx) => {
          // Capture and invalidation use the same lock scope.  This ensures a
          // newer publication cannot be activated between the CAS and receipt.
          await tx`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${myFplSnapshotEventLockScope(row.season_id, row.event_id)}, 0)
            )
          `;
          const ownership = await tx<{ outbox_id: string }[]>`
            SELECT outbox_id
            FROM competition.my_fpl_snapshot_invalidation_outbox
            WHERE outbox_id = ${row.outbox_id}::uuid AND lease_owner = ${owner}
            FOR UPDATE
          `;
          if (!ownership[0]) return 'lost' as const;

          const result = parseMyFplSnapshotInvalidationResult(
            await redis!.eval(
              MY_FPL_SNAPSHOT_INVALIDATE_SCRIPT,
              1,
              myFplSnapshotRedisManifestKey(row.season_code, row.event_id),
              String(row.revision),
            ),
          );
          if (result === 'different') {
            await tx`
              UPDATE competition.my_fpl_snapshot_invalidation_outbox
              SET status = 'SUPERSEDED',
                  delivered_at = clock_timestamp(),
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  last_error = 'Redis manifest is owned by a different revision',
                  updated_at = clock_timestamp()
              WHERE outbox_id = ${row.outbox_id}::uuid AND lease_owner = ${owner}
            `;
            return 'superseded' as const;
          }
          await tx`
            UPDATE competition.my_fpl_snapshot_invalidation_outbox
            SET status = 'DELIVERED',
                delivered_at = clock_timestamp(),
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                updated_at = clock_timestamp()
            WHERE outbox_id = ${row.outbox_id}::uuid AND lease_owner = ${owner}
          `;
          return 'delivered' as const;
        });
        if (status === 'superseded') {
          superseded += 1;
        } else if (status === 'delivered') {
          delivered += 1;
          logInfo('Delivered My FPL snapshot invalidation', {
            outboxId: row.outbox_id,
            eventId: row.event_id,
            revision: row.revision,
            tournamentId: row.tournament_id,
          });
        }
      } catch (error) {
        failed += 1;
        logWarn('My FPL snapshot invalidation delivery failed', {
          outboxId: row.outbox_id,
          eventId: row.event_id,
          revision: row.revision,
          error: error instanceof Error ? error.message : String(error),
        });
        await db.begin((tx) => releaseClaim(tx, row.outbox_id, owner, error));
      }
    }

    return {
      claimed: claimed.length,
      delivered,
      superseded,
      failed,
      remaining: await countRemaining(db, options),
    };
  };
}

export const dispatchMyFplSnapshotInvalidationOutbox = createMyFplSnapshotInvalidationDispatcher();
