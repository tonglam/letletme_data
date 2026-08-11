import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  dataPublicationItemKey,
  type DataPublicationManifest,
} from '../../src/cache/data-publication';
import { getDbClient } from '../../src/db/singleton';
import type { FplSeasonRef } from '../../src/domain/fpl-season';
import { seasonRepository } from '../../src/repositories/seasons';
import { syncOperationsRepository } from '../../src/repositories/sync-operations';
import { DatabaseError } from '../../src/utils/errors';

const RUN_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
] as const;

const PUBLICATION_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
] as const;

const TEST_SEASON_ID = 2096;
const TEST_SEASON_CODE = '9697';

async function seedSeason(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    INSERT INTO fpl.seasons (
      season_id,
      season_code,
      display_name,
      start_year,
      end_year,
      lifecycle_state,
      is_current
    )
    VALUES (
      ${TEST_SEASON_ID},
      ${TEST_SEASON_CODE},
      '2096/97 sync operations integration',
      ${TEST_SEASON_ID},
      ${TEST_SEASON_ID + 1},
      'completed',
      false
    )
  `;
}

async function cleanupSeason(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM fpl.seasons
    WHERE season_id = ${TEST_SEASON_ID}
      AND season_code = ${TEST_SEASON_CODE}
  `;
}

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    UPDATE ops.sync_runs
    SET publication_id = NULL
    WHERE run_id = ANY(${[...RUN_IDS]}::uuid[])
  `;
  await sql`
    DELETE FROM ops.dataset_publications
    WHERE publication_id = ANY(${[...PUBLICATION_IDS]}::uuid[])
  `;
  await sql`
    DELETE FROM ops.sync_runs
    WHERE run_id = ANY(${[...RUN_IDS]}::uuid[])
  `;
}

async function expectDatabaseErrorCode(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
    throw new Error(`Expected DatabaseError ${expectedCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe(expectedCode);
  }
}

function publicationManifest(
  publicationId: string,
  revision: number,
  season: FplSeasonRef,
): DataPublicationManifest {
  const payload = '[]';
  return {
    dataset: 'fpl:core',
    seasonCode: season.seasonCode,
    eventId: null,
    revision,
    publicationId,
    sourceCheckedAt: '2026-08-09T01:00:00.000Z',
    publishedAt: '2026-08-09T01:00:01.000Z',
    state: 'active',
    items: ['events', 'teams', 'players', 'phases', 'fixtures', 'currentEventId'].map((name) => ({
      name,
      key: dataPublicationItemKey(
        { dataset: 'fpl:core', seasonCode: season.seasonCode },
        revision,
        name,
      ),
      type: 'string',
      count: 0,
      bytes: Buffer.byteLength(payload, 'utf8'),
      sha256: createHash('sha256').update(payload, 'utf8').digest('hex'),
    })),
  };
}

async function startRun(runId: string, season: FplSeasonRef, lane = 'core'): Promise<string> {
  return syncOperationsRepository.startRun({
    runId,
    provider: 'fpl',
    lane,
    scope: 'integration-contract',
    season,
    mode: 'full',
    trigger: 'test',
    expectedItems: 1,
    metadata: { test: 'sync-operations' },
    startedAt: new Date('2026-08-08T00:00:00.000Z'),
  });
}

beforeAll(seedSeason);
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await cleanupSeason();
});

describe('ops sync state machine', () => {
  test('rejects a non-RFC publication identity before writing', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);
    await expectDatabaseErrorCode(
      syncOperationsRepository.preparePublication({
        publicationId: '20000000-0000-4000-6000-000000000001',
        dataset: 'fpl:core',
        season,
        sourceRunId: RUN_IDS[0],
      }),
      'DATASET_PUBLICATION_ID_INVALID',
    );
  });

  test('makes run identity idempotent and rejects an immutable-identity conflict', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    expect(await startRun(RUN_IDS[0], season)).toBe(RUN_IDS[0]);
    expect(await startRun(RUN_IDS[0], season)).toBe(RUN_IDS[0]);

    await expectDatabaseErrorCode(startRun(RUN_IDS[0], season, 'live'), 'SYNC_RUN_ID_CONFLICT');
  });

  test('keeps the highest item attempt and its payload when a stale update arrives', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);

    await syncOperationsRepository.upsertItems(RUN_IDS[0], [
      {
        resourceType: 'event',
        resourceId: '1',
        status: 'completed',
        attempts: 2,
        sourceHash: 'new-hash',
        normalizedPayload: { attempt: 2 },
        completedAt: new Date('2026-08-09T00:02:00.000Z'),
      },
    ]);
    await syncOperationsRepository.upsertItems(RUN_IDS[0], [
      {
        resourceType: 'event',
        resourceId: '1',
        status: 'running',
        attempts: 1,
        sourceHash: 'stale-hash',
        normalizedPayload: { attempt: 1 },
      },
    ]);

    const rows = await sql<
      Array<{
        status: string;
        attempts: number;
        source_hash: string | null;
        normalized_payload: { attempt: number } | null;
        completed_at: Date | string | null;
      }>
    >`
      SELECT status, attempts, source_hash, normalized_payload, completed_at
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[0]}::uuid
        AND resource_type = 'event'
        AND resource_id = '1'
    `;
    expect(rows[0]).toMatchObject({
      status: 'completed',
      attempts: 2,
      source_hash: 'new-hash',
      normalized_payload: { attempt: 2 },
    });
    expect(new Date(String(rows[0]?.completed_at)).toISOString()).toBe('2026-08-09T00:02:00.000Z');
  });

  test('keeps terminal run transitions idempotent and rejects a different terminal state', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);

    await syncOperationsRepository.finishRun(RUN_IDS[0], {
      status: 'completed',
      completedItems: 1,
      dataChanged: false,
    });
    await syncOperationsRepository.finishRun(RUN_IDS[0], {
      status: 'completed',
      completedItems: 1,
      dataChanged: false,
    });
    await expectDatabaseErrorCode(
      syncOperationsRepository.finishRun(RUN_IDS[0], {
        status: 'skipped',
        completedItems: 0,
        skippedItems: 1,
        dataChanged: false,
      }),
      'SYNC_RUN_TERMINAL_STATE_CONFLICT',
    );

    await syncOperationsRepository.failRun(RUN_IDS[0], new Error('stale failure'));
    const rows = await sql<Array<{ status: string; error_summary: string | null }>>`
      SELECT status, error_summary
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(rows[0]).toEqual({ status: 'completed', error_summary: null });
  });

  test('atomically replaces the active publication and retires the prior revision', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);
    await startRun(RUN_IDS[1], season);

    const first = await syncOperationsRepository.preparePublication({
      publicationId: PUBLICATION_IDS[0],
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[0],
      manifest: { state: 'staging' },
    });
    expect(
      await syncOperationsRepository.preparePublication({
        publicationId: PUBLICATION_IDS[0],
        dataset: 'fpl:core',
        season,
        sourceRunId: RUN_IDS[0],
        manifest: { state: 'different-retry-payload' },
      }),
    ).toEqual(first);
    await expectDatabaseErrorCode(
      syncOperationsRepository.preparePublication({
        publicationId: PUBLICATION_IDS[0],
        dataset: 'fpl:core',
        season,
        sourceRunId: RUN_IDS[1],
      }),
      'DATASET_PUBLICATION_ID_CONFLICT',
    );

    await syncOperationsRepository.activatePublication({
      publicationId: first.publicationId,
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[0],
      manifest: publicationManifest(first.publicationId, first.revision, season),
    });
    expect(await syncOperationsRepository.findActivePublication('fpl:core', season)).toEqual({
      publicationId: first.publicationId,
      revision: first.revision,
      status: 'active',
    });

    const second = await syncOperationsRepository.preparePublication({
      publicationId: PUBLICATION_IDS[1],
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[1],
    });
    expect(second.revision).toBeGreaterThan(first.revision);
    const secondManifest = publicationManifest(second.publicationId, second.revision, season);
    await syncOperationsRepository.activatePublication({
      publicationId: second.publicationId,
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[1],
      manifest: secondManifest,
    });
    await syncOperationsRepository.activatePublication({
      publicationId: second.publicationId,
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[1],
      manifest: secondManifest,
    });

    const publications = await sql<
      Array<{
        publication_id: string;
        status: string;
        retired_at: Date | null;
        expires_at: Date | null;
      }>
    >`
      SELECT publication_id, status, retired_at, expires_at
      FROM ops.dataset_publications
      WHERE publication_id = ANY(${[...PUBLICATION_IDS]}::uuid[])
      ORDER BY revision
    `;
    expect(publications).toHaveLength(2);
    expect(publications[0]).toMatchObject({
      publication_id: PUBLICATION_IDS[0],
      status: 'retired',
    });
    expect(publications[0]?.retired_at).not.toBeNull();
    expect(publications[0]?.expires_at).not.toBeNull();
    expect(publications[1]).toMatchObject({
      publication_id: PUBLICATION_IDS[1],
      status: 'active',
      retired_at: null,
      expires_at: null,
    });

    const activeScopes = await sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM ops.dataset_publications
      WHERE dataset = 'fpl:core'
        AND season_id = ${season.seasonId}
        AND event_id IS NULL
        AND status = 'active'
    `;
    expect(activeScopes[0]?.count).toBe(1);

    await expectDatabaseErrorCode(
      syncOperationsRepository.activatePublication({
        publicationId: first.publicationId,
        dataset: 'fpl:core',
        season,
        sourceRunId: RUN_IDS[0],
        manifest: publicationManifest(first.publicationId, first.revision, season),
      }),
      'DATASET_PUBLICATION_TERMINAL_STATE_CONFLICT',
    );
  });

  test('fails a staging publication and its source run idempotently', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[2], season);
    await syncOperationsRepository.preparePublication({
      publicationId: PUBLICATION_IDS[2],
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[2],
    });

    await syncOperationsRepository.failPublication(PUBLICATION_IDS[2], new Error('bounded'));
    await syncOperationsRepository.failPublication(PUBLICATION_IDS[2], new Error('retry'));

    const rows = await sql<Array<{ publication_status: string; run_status: string }>>`
      SELECT publication.status AS publication_status, run.status AS run_status
      FROM ops.dataset_publications publication
      JOIN ops.sync_runs run ON run.run_id = publication.source_run_id
      WHERE publication.publication_id = ${PUBLICATION_IDS[2]}::uuid
    `;
    expect(rows[0]).toEqual({ publication_status: 'failed', run_status: 'failed' });
  });
});
