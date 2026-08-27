import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { getDbClient } from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import {
  createTournamentManagementRepository,
  type TournamentDeleteResult,
} from '../../src/repositories/tournament-management';
import {
  createMyFplSnapshotInvalidationDispatcher,
  dispatchMyFplSnapshotInvalidationOutbox,
} from '../../src/services/my-fpl-snapshot-invalidation.service';
import {
  getMyFplSnapshotOperationalStatus,
  myFplSnapshotRedisManifestKey,
} from '../../src/services/my-fpl-snapshot-publication.service';

/**
 * This suite deliberately uses a disposable season and high, namespaced IDs.
 * It proves the cross-store ordering that unit fakes cannot prove: the
 * PostgreSQL delete commits with a durable receipt even when Redis is down,
 * then the receipt is retried with revision-safe CAS semantics.
 */
const SEASON_CODE = '9394';
const SEASON = explicitSeasonRef(SEASON_CODE);
const EVENT_ID = 1;
const ENTRY_ID = 993_901;
const TOURNAMENT_ID = 993_901;
const LEAGUE_ID = 993_901;
const REVISION = 9_390_001;
const KEY = myFplSnapshotRedisManifestKey(SEASON_CODE, EVENT_ID);

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.my_fpl_snapshot_invalidation_outbox
    WHERE season_id = ${SEASON.seasonId}
  `;
  await sql`
    DELETE FROM competition.my_fpl_snapshot_publications
    WHERE season_id = ${SEASON.seasonId}
  `;
  await sql`
    DELETE FROM fpl.manager_live_tournament_coverage
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournament_knockout_results
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournament_knockouts
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournament_battle_group_results
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournament_points_group_results
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournament_groups
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournament_entries
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournaments
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.entries
    WHERE season_id = ${SEASON.seasonId} AND entry_id = ${ENTRY_ID}
  `;
  await sql`
    DELETE FROM fpl.events
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM fpl.seasons
    WHERE season_id = ${SEASON.seasonId}
  `;
  const redis = await redisSingleton.getClient();
  await redis.unlink(KEY);
}

async function seed(): Promise<void> {
  const sql = await getDbClient();
  await cleanup();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
    ) VALUES (
      ${SEASON.seasonId}, ${SEASON_CODE}, 'My FPL invalidation integration',
      ${SEASON.seasonId}, ${SEASON.seasonId + 1}, 'completed', false
    )
  `;
  await sql`
    INSERT INTO fpl.events (season_id, event_id, name, finished, data_checked)
    VALUES (${SEASON.seasonId}, ${EVENT_ID}, 'Invalidation GW 1', false, false)
  `;
  await sql`
    INSERT INTO competition.entries (season_id, entry_id, entry_name, player_name)
    VALUES (${SEASON.seasonId}, ${ENTRY_ID}, 'Invalidation Entry', 'Invalidation Manager')
  `;
  await sql`
    INSERT INTO competition.tournaments (
      tournament_id, season_id, name, creator, admin_entry_id, league_id,
      league_type, total_team_num, tournament_mode, group_mode,
      group_auto_averages, state
    ) VALUES (
      ${TOURNAMENT_ID}, ${SEASON.seasonId}, 'Invalidation Tournament', 'integration-test',
      ${ENTRY_ID}, ${LEAGUE_ID}, 'classic', 1, 'normal', 'no_group', false, 'active'
    )
  `;
  await sql`
    INSERT INTO competition.my_fpl_snapshot_publications (
      season_id, event_id, revision, snapshot_date, source_checked_at, published_at,
      kind, active, expected_entry_count, ready_entry_count, empty_entry_count,
      expected_tournament_count, ready_tournament_count, content_sha256
    ) VALUES (
      ${SEASON.seasonId}, ${EVENT_ID}, ${REVISION}, '2026-08-28', now(), now(),
      'PROVISIONAL', true, 1, 1, 0, 1, 1,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  `;
  await sql`
    INSERT INTO competition.my_fpl_snapshot_tournament_rows (
      season_id, event_id, revision, tournament_id, entry_id, payload
    ) VALUES (
      ${SEASON.seasonId}, ${EVENT_ID}, ${REVISION}, ${TOURNAMENT_ID}, ${ENTRY_ID}, '{}'::jsonb
    )
  `;
}

async function readOutbox(outboxId: string): Promise<{
  status: string;
  attempts: number;
  available_at: Date;
}> {
  const sql = await getDbClient();
  const rows = await sql<{ status: string; attempts: number; available_at: Date }[]>`
    SELECT status, attempts, available_at
    FROM competition.my_fpl_snapshot_invalidation_outbox
    WHERE outbox_id = ${outboxId}::uuid
  `;
  if (!rows[0]) throw new Error(`missing invalidation outbox ${outboxId}`);
  return rows[0];
}

async function insertReceipt(revision: number): Promise<string> {
  const sql = await getDbClient();
  const rows = await sql<{ outbox_id: string }[]>`
    INSERT INTO competition.my_fpl_snapshot_invalidation_outbox (
      season_id, event_id, revision, tournament_id, reason, status, available_at
    ) VALUES (
      ${SEASON.seasonId}, ${EVENT_ID}, ${revision}, ${TOURNAMENT_ID},
      'TOURNAMENT_DELETED', 'PENDING', now()
    )
    RETURNING outbox_id
  `;
  return rows[0].outbox_id;
}

beforeAll(seed);
afterAll(cleanup);

describe('My FPL snapshot invalidation outbox', () => {
  test('commits deletion before Redis delivery and retries after Redis failure', async () => {
    const repository = createTournamentManagementRepository();
    const redis = await redisSingleton.getClient();
    await redis.set(KEY, JSON.stringify({ revision: REVISION }));

    const result = (await repository.deleteOwned(SEASON, TOURNAMENT_ID, ENTRY_ID)) as Extract<
      TournamentDeleteResult,
      { status: 'deleted' }
    >;
    expect(result.status).toBe('deleted');
    expect(result.invalidationOutboxIds).toHaveLength(1);
    const outboxId = result.invalidationOutboxIds?.[0];
    expect(outboxId).toBeString();
    if (!outboxId) throw new Error('delete did not return an invalidation outbox id');

    const [deletedTournament, deletedPublication, pointerBeforeRetry] = await Promise.all([
      (await getDbClient())`
        SELECT 1 FROM competition.tournaments
        WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${TOURNAMENT_ID}
      `,
      (await getDbClient())`
        SELECT 1 FROM competition.my_fpl_snapshot_publications
        WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
      `,
      redis.get(KEY),
    ]);
    expect(deletedTournament).toHaveLength(0);
    expect(deletedPublication).toHaveLength(0);
    expect(pointerBeforeRetry).toBe(JSON.stringify({ revision: REVISION }));

    const failedDispatcher = createMyFplSnapshotInvalidationDispatcher({
      getRedisClient: async () => {
        throw new Error('redis intentionally unavailable');
      },
    });
    const failed = await failedDispatcher({ outboxIds: [outboxId], limit: 1 });
    expect(failed).toMatchObject({ claimed: 1, failed: 1, delivered: 0 });
    expect((await readOutbox(outboxId!)).status).toBe('FAILED');
    const failedOperationalStatus = (await getMyFplSnapshotOperationalStatus(SEASON)).find(
      (status) => status.eventId === EVENT_ID,
    );
    expect(failedOperationalStatus).toMatchObject({
      pendingInvalidationCount: 1,
      invalidationAttempts: 1,
    });

    const sql = await getDbClient();
    await sql`
      UPDATE competition.my_fpl_snapshot_invalidation_outbox
      SET available_at = now()
      WHERE outbox_id = ${outboxId}::uuid
    `;
    const delivered = await dispatchMyFplSnapshotInvalidationOutbox({
      outboxIds: [outboxId],
      limit: 1,
    });
    expect(delivered).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect((await readOutbox(outboxId!)).status).toBe('DELIVERED');
    expect(await redis.get(KEY)).toBeNull();
  });

  test('supersedes a receipt when Redis already points at another revision', async () => {
    const revision = REVISION + 1;
    const outboxId = await insertReceipt(revision);
    const redis = await redisSingleton.getClient();
    await redis.set(KEY, JSON.stringify({ revision: revision + 1 }));

    const result = await dispatchMyFplSnapshotInvalidationOutbox({ outboxIds: [outboxId] });
    expect(result).toMatchObject({ claimed: 1, superseded: 1, delivered: 0, failed: 0 });
    expect((await readOutbox(outboxId)).status).toBe('SUPERSEDED');
    expect(await redis.get(KEY)).toBe(JSON.stringify({ revision: revision + 1 }));
  });

  test('deletes malformed pointers, reclaims expired leases, and claims once concurrently', async () => {
    const malformedRevision = REVISION + 2;
    const malformedId = await insertReceipt(malformedRevision);
    const redis = await redisSingleton.getClient();
    await redis.set(KEY, 'not-json');
    const malformed = await dispatchMyFplSnapshotInvalidationOutbox({ outboxIds: [malformedId] });
    expect(malformed).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect(await redis.get(KEY)).toBeNull();

    const reclaimedRevision = REVISION + 3;
    const reclaimedId = await insertReceipt(reclaimedRevision);
    const sql = await getDbClient();
    await sql`
      UPDATE competition.my_fpl_snapshot_invalidation_outbox
      SET status = 'PROCESSING', attempts = 4, lease_owner = 'dead-worker',
          lease_expires_at = now() - interval '1 second'
      WHERE outbox_id = ${reclaimedId}::uuid
    `;
    const reclaimed = await dispatchMyFplSnapshotInvalidationOutbox({
      outboxIds: [reclaimedId],
      limit: 1,
    });
    expect(reclaimed).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect((await readOutbox(reclaimedId)).attempts).toBe(5);

    const concurrentRevision = REVISION + 4;
    const concurrentId = await insertReceipt(concurrentRevision);
    const concurrent = await Promise.all([
      dispatchMyFplSnapshotInvalidationOutbox({ outboxIds: [concurrentId], limit: 1 }),
      dispatchMyFplSnapshotInvalidationOutbox({ outboxIds: [concurrentId], limit: 1 }),
    ]);
    expect(concurrent.reduce((sum, item) => sum + item.delivered, 0)).toBe(1);
    expect((await readOutbox(concurrentId)).status).toBe('DELIVERED');
    expect((await readOutbox(concurrentId)).attempts).toBe(1);
  });
});
