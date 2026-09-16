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
import { runDataSyncAttempt, type DataSyncAttemptContext } from '../../src/utils/data-sync-attempt';
import { withMutationScopes } from '../../src/utils/mutation-scopes';

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
  await sql`
    DELETE FROM ops.sync_runs
    WHERE season_id = ${TEST_SEASON_ID}
      AND mode = 'batch-cost'
  `;
  await sql`
    DELETE FROM fpl.events
    WHERE season_id = ${TEST_SEASON_ID}
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
  sourceCheckedAt = '2026-08-09T01:00:00.000Z',
): DataPublicationManifest {
  const payload = '[]';
  return {
    dataset: 'fpl:core',
    seasonCode: season.seasonCode,
    eventId: null,
    revision,
    publicationId,
    sourceCheckedAt,
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

async function startRun(
  runId: string,
  season: FplSeasonRef,
  lane = 'core',
  eventId?: number,
): Promise<string> {
  return syncOperationsRepository.startRun({
    runId,
    provider: 'fpl',
    lane,
    scope: 'integration-contract',
    season,
    ...(eventId === undefined ? {} : { eventId }),
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

  test('terminalizes only pending audit items and preserves failed request evidence', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);

    await syncOperationsRepository.upsertItems(RUN_IDS[0], [
      {
        resourceType: 'entry-event',
        resourceId: 'pending',
        status: 'pending',
        attempts: 1,
        normalizedPayload: { phase: 'entry-event-results' },
      },
      {
        resourceType: 'entry-event',
        resourceId: 'failed',
        status: 'failed',
        attempts: 1,
        normalizedPayload: {
          phase: 'entry-event-results',
          picksRequests: 1,
          unknownRequests: 1,
        },
        lastError: 'provider timeout',
      },
    ]);

    await syncOperationsRepository.failPendingItems(RUN_IDS[0], new Error('planning failed'));

    const rows = await sql<
      Array<{
        resource_id: string;
        status: string;
        normalized_payload: Record<string, unknown> | null;
        last_error: string | null;
      }>
    >`
      SELECT resource_id, status, normalized_payload, last_error
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[0]}::uuid
      ORDER BY resource_id
    `;
    expect(Array.from(rows)).toEqual([
      {
        resource_id: 'failed',
        status: 'failed',
        normalized_payload: {
          phase: 'entry-event-results',
          picksRequests: 1,
          unknownRequests: 1,
        },
        last_error: 'provider timeout',
      },
      {
        resource_id: 'pending',
        status: 'failed',
        normalized_payload: {
          phase: 'entry-event-results',
          setupFailure: true,
          unknownRequests: 0,
        },
        last_error: 'planning failed',
      },
    ]);
  });

  test('resource-scoped terminalization does not fail sibling components', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[1], season);

    await syncOperationsRepository.upsertItems(RUN_IDS[1], [
      {
        resourceType: 'entry-event',
        resourceId: 'entry:transfers',
        status: 'pending',
        attempts: 1,
        normalizedPayload: { phase: 'entry-transfer-history' },
      },
      {
        resourceType: 'entry-event',
        resourceId: 'entry:results',
        status: 'pending',
        attempts: 1,
        normalizedPayload: { phase: 'entry-event-results' },
      },
    ]);

    await syncOperationsRepository.failPendingItems(
      RUN_IDS[1],
      new Error('transfer convergence read failed'),
      ['entry:transfers'],
    );

    const rows = await sql<Array<{ resource_id: string; status: string }>>`
      SELECT resource_id, status
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[1]}::uuid
      ORDER BY resource_id
    `;
    expect(Array.from(rows)).toEqual([
      { resource_id: 'entry:results', status: 'pending' },
      { resource_id: 'entry:transfers', status: 'failed' },
    ]);
  });

  test('does not certify a failed provisional result from request accounting alone', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await sql`
      INSERT INTO fpl.events (
        season_id,
        event_id,
        name,
        finished,
        data_checked,
        data_checked_at
      )
      VALUES (
        ${TEST_SEASON_ID},
        1,
        'GW1',
        false,
        false,
        NULL
      )
    `;
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[1],
      provider: 'fpl',
      lane: 'entry',
      scope: 'entry-event',
      season,
      eventId: 1,
      mode: 'entry-event-results',
      trigger: 'test',
      expectedItems: 1,
      startedAt: new Date('2026-08-08T00:00:00.000Z'),
    });
    const resultResourceId = `${TEST_SEASON_ID}:1:123:results`;
    await syncOperationsRepository.upsertItems(RUN_IDS[1], [
      {
        resourceType: 'entry-event',
        resourceId: resultResourceId,
        status: 'failed',
        attempts: 1,
        normalizedPayload: {
          phase: 'entry-event-results',
          unknownRequests: 1,
        },
        lastError: 'provider timeout',
      },
    ]);

    const failedAudit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(failedAudit.evidenceComplete).toBe(false);
    expect(failedAudit.reasonCodes).toContain('SYNC_AUDIT_RESULT_EVIDENCE_MISSING');

    await syncOperationsRepository.upsertItems(RUN_IDS[1], [
      {
        resourceType: 'entry-event',
        resourceId: resultResourceId,
        status: 'completed',
        attempts: 2,
        normalizedPayload: {
          phase: 'entry-event-results',
          factCommit: 'reused',
          reused: true,
        },
      },
    ]);

    const recoveredAudit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(recoveredAudit.evidenceComplete).toBe(true);
    expect(recoveredAudit.reasonCodes).toEqual([]);
  });

  test('does not let a superseded run keep a later durable audit incomplete', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    const resourceId = `${TEST_SEASON_ID}:1:123:results`;
    await startRun(RUN_IDS[0], season, 'entry', 1);
    await syncOperationsRepository.upsertItems(RUN_IDS[0], [
      {
        resourceType: 'entry-event',
        resourceId,
        status: 'pending',
        attempts: 1,
        normalizedPayload: { phase: 'entry-event-results' },
      },
    ]);

    await startRun(RUN_IDS[1], season, 'entry', 1);
    await syncOperationsRepository.upsertItems(RUN_IDS[1], [
      {
        resourceType: 'entry-event',
        resourceId,
        status: 'completed',
        attempts: 1,
        normalizedPayload: { factCommit: 'committed' },
      },
    ]);

    const audit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(audit.evidenceComplete).toBe(true);
    expect(audit.reasonCodes).toEqual([]);
  });

  test('allows same-attempt durable convergence to replace a provisional failure', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);
    const resourceId = 'same-attempt-convergence';

    await syncOperationsRepository.upsertItems(RUN_IDS[0], [
      {
        resourceType: 'entry-event',
        resourceId,
        status: 'failed',
        attempts: 1,
        normalizedPayload: { phase: 'entry-event-results', unknownRequests: 1 },
        lastError: 'provider timeout',
      },
    ]);
    await syncOperationsRepository.upsertItems(RUN_IDS[0], [
      {
        resourceType: 'entry-event',
        resourceId,
        status: 'completed',
        attempts: 1,
        normalizedPayload: { phase: 'entry-event-results', factCommit: 'reused' },
        completedAt: new Date('2026-08-08T00:01:00.000Z'),
      },
    ]);
    // A late same-attempt running/failed write must not undo the converged
    // terminal evidence.
    await syncOperationsRepository.upsertItems(RUN_IDS[0], [
      {
        resourceType: 'entry-event',
        resourceId,
        status: 'running',
        attempts: 1,
        normalizedPayload: { phase: 'late-replay' },
      },
    ]);

    const [row] = await sql<Array<{ status: string; last_error: string | null }>>`
      SELECT status, last_error
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[0]}::uuid
        AND resource_type = 'entry-event'
        AND resource_id = ${resourceId}
    `;
    expect(row).toEqual({ status: 'completed', last_error: null });
  });

  test('does not certify results while a transfer component is unresolved', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[1], season, 'entry', 1);
    await syncOperationsRepository.upsertItems(RUN_IDS[1], [
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:results`,
        status: 'completed',
        attempts: 1,
        normalizedPayload: { factCommit: 'reused', reused: true },
      },
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:transfers`,
        status: 'failed',
        attempts: 1,
        normalizedPayload: { unknownRequests: 1 },
        lastError: 'provider timeout',
      },
    ]);

    const incompleteAudit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(incompleteAudit.evidenceComplete).toBe(false);
    expect(incompleteAudit.reasonCodes).toContain('SYNC_AUDIT_TRANSFER_EVIDENCE_MISSING');

    await syncOperationsRepository.upsertItems(RUN_IDS[1], [
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:transfers`,
        status: 'skipped',
        attempts: 2,
        normalizedPayload: {
          factCommit: 'reused',
          reused: true,
        },
      },
    ]);
    const recoveredAudit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(recoveredAudit.evidenceComplete).toBe(true);
    expect(recoveredAudit.reasonCodes).toEqual([]);
  });

  test('counts a combined transfer failure only on the transfer component', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[2], season, 'entry', 1);
    await syncOperationsRepository.upsertItems(RUN_IDS[2], [
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:results`,
        status: 'failed',
        attempts: 1,
        normalizedPayload: {
          phase: 'entry-event-results',
          picksRequests: 1,
          transferRequests: 0,
          unknownRequests: 0,
        },
        lastError: 'transfer provider timeout',
      },
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:transfers`,
        status: 'failed',
        attempts: 1,
        normalizedPayload: {
          phase: 'entry-transfer-history',
          transferRequests: 1,
          unknownRequests: 1,
        },
        lastError: 'transfer provider timeout',
      },
    ]);

    const audit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(audit.providerRequests).toEqual({
      eventLive: 0,
      picks: 1,
      transfers: 1,
      unknown: 1,
    });
  });

  test('counts only the final audit component as a durable FINAL completion', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[2],
      provider: 'fpl',
      lane: 'entry',
      scope: 'entry-event',
      season,
      eventId: 1,
      mode: 'final',
      trigger: 'repair',
      expectedItems: 3,
      startedAt: new Date('2026-08-08T00:00:00.000Z'),
    });

    await syncOperationsRepository.upsertItems(RUN_IDS[2], [
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:results`,
        status: 'completed',
        attempts: 1,
        normalizedPayload: { finalCompletion: true, factCommit: 'committed' },
      },
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:transfers`,
        status: 'skipped',
        attempts: 1,
        normalizedPayload: { reused: true },
      },
    ]);

    const sql = await getDbClient();
    await sql`
      INSERT INTO fpl.events (
        season_id,
        event_id,
        name,
        finished,
        data_checked,
        data_checked_at
      )
      VALUES (
        ${TEST_SEASON_ID},
        1,
        'GW1',
        true,
        true,
        '2026-08-09T00:00:00.000Z'::timestamptz
      )
    `;

    const incompleteAudit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(incompleteAudit.finalCompletions).toBe(0);
    expect(incompleteAudit.evidenceComplete).toBe(false);

    await syncOperationsRepository.upsertItems(RUN_IDS[2], [
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:final`,
        status: 'skipped',
        attempts: 1,
        normalizedPayload: {
          finalCompletion: true,
          reused: true,
          sourceRevision: '2026-08-09T00:00:00.000Z',
        },
      },
    ]);

    const audit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(audit.finalCompletions).toBe(1);
    expect(audit.executions).toBe(1);
    expect(audit.evidenceComplete).toBe(true);
    expect(audit.coverageStartAt).not.toBeNull();

    await sql`
      UPDATE fpl.events
      SET data_checked_at = '2026-08-10T00:00:00.000Z'::timestamptz
      WHERE season_id = ${TEST_SEASON_ID}
        AND event_id = 1
    `;
    const reopenedAudit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(reopenedAudit.finalCompletions).toBe(0);
    expect(reopenedAudit.evidenceComplete).toBe(false);

    await syncOperationsRepository.upsertItems(RUN_IDS[2], [
      {
        resourceType: 'entry-event',
        resourceId: `${TEST_SEASON_ID}:1:123:final`,
        status: 'skipped',
        attempts: 2,
        normalizedPayload: {
          finalCompletion: true,
          reused: true,
          sourceRevision: '2026-08-10T00:00:00.000Z',
        },
      },
    ]);
    const refinalizedAudit = await syncOperationsRepository.entrySyncAudit({
      seasonId: TEST_SEASON_ID,
      eventId: 1,
      entryId: 123,
    });
    expect(refinalizedAudit.finalCompletions).toBe(1);
    expect(refinalizedAudit.evidenceComplete).toBe(true);
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

  test('keeps one start marker and one settlement per batch attempt', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);

    const input = {
      attemptKey: 'entry-sync|entry-results|batch-1|1|4',
      batchId: 'batch-1',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt: 1,
    } as const;
    expect(
      await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
        ...input,
        payload: { startedAt: '2026-08-09T00:00:00.000Z' },
      }),
    ).toBe('recorded');
    expect(
      await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
        ...input,
        payload: { startedAt: '2026-08-09T00:00:01.000Z' },
      }),
    ).toBe('duplicate');
    expect(
      await syncOperationsRepository.recordBatchCost(RUN_IDS[0], {
        ...input,
        complete: true,
        payload: {
          logicalRequests: 2,
          httpAttempts: 3,
          httpRetries: 1,
          providerResponseSamples: 3,
          providerResponse429: 1,
          providerResponse5xx: 0,
          providerNetworkErrors: 0,
          providerDurationMs: 900,
          providerDurationSamples: 3,
          requiredUnits: null,
          writeAccounting: 'unknown',
          endpointRequests: { entry_results: 2 },
        },
      }),
    ).toBe('recorded');
    expect(
      await syncOperationsRepository.recordBatchCost(RUN_IDS[0], {
        ...input,
        complete: true,
        payload: { logicalRequests: 2 },
      }),
    ).toBe('duplicate');
    const retryInput = {
      ...input,
      attemptKey: 'entry-sync|entry-results|batch-1|2|4',
      attempt: 2,
    } as const;
    expect(
      await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
        ...retryInput,
        payload: { startedAt: '2026-08-09T00:01:00.000Z' },
      }),
    ).toBe('recorded');
    expect(
      await syncOperationsRepository.recordBatchCost(RUN_IDS[0], {
        ...retryInput,
        complete: false,
        payload: {
          logicalRequests: 1,
          httpAttempts: 1,
          httpRetries: 0,
          providerResponseSamples: 1,
          providerResponse429: 0,
          providerResponse5xx: 1,
          providerNetworkErrors: 1,
          providerDurationMs: 400,
          providerDurationSamples: 1,
          requiredUnits: null,
          writeAccounting: 'unknown',
          endpointRequests: { entry_results: 1 },
        },
      }),
    ).toBe('recorded');

    const rows = await sql<
      Array<{
        status: string;
        phase: string;
        logicalRequests: number | null;
      }>
    >`
      SELECT status, normalized_payload->>'phase' AS phase,
             (normalized_payload->>'logicalRequests')::integer AS "logicalRequests"
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[0]}::uuid
        AND resource_type = 'batch-cost'
      ORDER BY resource_id
    `;
    expect([...rows]).toEqual([
      { status: 'completed', phase: 'settled', logicalRequests: 2 },
      { status: 'failed', phase: 'settled', logicalRequests: 1 },
    ]);
    const [run] = await sql<
      Array<{ metadata: { batchCost?: { totals?: Record<string, unknown> } } }>
    >`
      SELECT metadata
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(run?.metadata.batchCost?.totals).toMatchObject({
      logicalRequests: 3,
      httpAttempts: 4,
      httpRetries: 1,
      providerResponseSamples: 4,
      providerResponse429: 1,
      providerResponse5xx: 1,
      providerNetworkErrors: 1,
      providerDurationMs: 1300,
      providerDurationSamples: 4,
      unitAccounting: 'per_attempt',
    });
  });

  test('records an in-flight target event and the settled outcome', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[2], season);
    const attemptKey = 'data-sync|player-stats|target-marker|1|none|execution-1';

    expect(
      await syncOperationsRepository.recordBatchCostStart(RUN_IDS[2], {
        attemptKey,
        batchId: 'target-marker',
        parentRunId: null,
        releaseSha: 'test-release',
        attempt: 1,
        payload: {
          startedAt: '2026-08-09T00:00:00.000Z',
          executionId: 'execution-1',
          outcome: 'pending',
        },
      }),
    ).toBe('recorded');
    expect(
      await syncOperationsRepository.updateBatchCostTargetEvent(RUN_IDS[2], attemptKey, 12),
    ).toBe(true);
    const [running] = await sql<Array<{ phase: string; eventId: number; outcome: string }>>`
      SELECT normalized_payload->>'phase' AS phase,
             (normalized_payload->>'eventId')::integer AS "eventId",
             normalized_payload->>'outcome' AS outcome
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[2]}::uuid
        AND resource_type = 'batch-cost'
        AND resource_id = ${attemptKey}
    `;
    expect(running).toEqual({ phase: 'started', eventId: 12, outcome: 'pending' });
    const [runningRun] = await sql<Array<{ event_id: number | null }>>`
      SELECT event_id
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[2]}::uuid
    `;
    expect(runningRun?.event_id).toBe(12);

    expect(
      await syncOperationsRepository.recordBatchCost(RUN_IDS[2], {
        attemptKey,
        batchId: 'target-marker',
        parentRunId: null,
        releaseSha: 'test-release',
        attempt: 1,
        complete: true,
        payload: { eventId: 12, outcome: 'ready', logicalRequests: 1 },
      }),
    ).toBe('recorded');
    const [settled] = await sql<Array<{ phase: string; eventId: number; outcome: string }>>`
      SELECT normalized_payload->>'phase' AS phase,
             (normalized_payload->>'eventId')::integer AS "eventId",
             normalized_payload->>'outcome' AS outcome
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[2]}::uuid
        AND resource_type = 'batch-cost'
        AND resource_id = ${attemptKey}
    `;
    expect(settled).toEqual({ phase: 'settled', eventId: 12, outcome: 'ready' });
    expect(
      await syncOperationsRepository.updateBatchCostTargetEvent(RUN_IDS[2], attemptKey, 13),
    ).toBe(false);
  });

  test('keeps an unscoped batch-cost retry compatible after event resolution', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    const run = {
      runId: RUN_IDS[0],
      provider: 'fpl',
      lane: 'data-sync',
      scope: 'entry-results',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
    } as const;
    await syncOperationsRepository.startRun(run);
    const attemptKey = 'data-sync|entry-results|unscoped-retry|1|none|execution-1';
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
      attemptKey,
      batchId: 'unscoped-retry',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt: 1,
      payload: { startedAt: '2026-08-09T00:00:00.000Z' },
    });
    expect(
      await syncOperationsRepository.updateBatchCostTargetEvent(RUN_IDS[0], attemptKey, 12),
    ).toBe(true);

    // The next delivery starts without an event in its Bull payload, while a
    // direct recovery may already know the resolved event. Both are the same
    // batch-cost ledger identity; a different positive event remains a real
    // immutable-scope conflict.
    expect(await syncOperationsRepository.startRun(run)).toBe(RUN_IDS[0]);
    expect(await syncOperationsRepository.startRun({ ...run, eventId: 12 })).toBe(RUN_IDS[0]);
    await expectDatabaseErrorCode(
      syncOperationsRepository.startRun({ ...run, eventId: 13 }),
      'SYNC_RUN_ID_CONFLICT',
    );
  });

  test('binds a recovered scoped batch-cost retry to an unscoped ledger', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    const run = {
      runId: RUN_IDS[0],
      provider: 'fpl',
      lane: 'data-sync',
      scope: 'player-stats',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
    } as const;

    await syncOperationsRepository.startRun(run);
    expect(await syncOperationsRepository.startRun({ ...run, eventId: 12 })).toBe(RUN_IDS[0]);
    const [bound] = await sql<Array<{ event_id: number | null }>>`
      SELECT event_id
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(bound?.event_id).toBe(12);
    await expectDatabaseErrorCode(
      syncOperationsRepository.startRun({ ...run, eventId: 13 }),
      'SYNC_RUN_ID_CONFLICT',
    );
  });

  test('stops an unscoped runner when its target event scope changes', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    const context: DataSyncAttemptContext = {
      queue: 'entry-sync',
      jobName: 'entry-results',
      runId: 'unscoped-runner',
      batchId: 'unscoped-runner',
      attempt: 1,
      season,
    };
    let providerWorkStarted = false;
    await expect(
      runDataSyncAttempt(context, async () => {
        await context.onTargetEventResolved?.(12);
        await context.onTargetEventResolved?.(13);
        providerWorkStarted = true;
        return { requiredUnits: 1, succeededUnits: 1 };
      }),
    ).rejects.toMatchObject({ code: 'SYNC_BATCH_COST_EVENT_CONFLICT' });
    expect(providerWorkStarted).toBe(false);
  });

  test('closes a running marker when batch-cost settlement fails', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[2], season);
    const attemptKey = 'data-sync|player-stats|settlement-failure|1|none|execution-1';

    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[2], {
      attemptKey,
      batchId: 'settlement-failure',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt: 1,
      payload: { startedAt: '2026-08-09T00:00:00.000Z' },
    });
    expect(
      await syncOperationsRepository.markBatchCostSettlementFailure(RUN_IDS[2], {
        attemptKey,
        attempt: 1,
        error: new Error('ledger write unavailable'),
      }),
    ).toBe(true);

    const [item] = await sql<Array<{ status: string; phase: string; incompleteReason: string }>>`
      SELECT status,
             normalized_payload->>'phase' AS phase,
             normalized_payload->>'incompleteReason' AS "incompleteReason"
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[2]}::uuid
        AND resource_type = 'batch-cost'
        AND resource_id = ${attemptKey}
    `;
    expect(item).toEqual({
      status: 'failed',
      phase: 'settlement_failed',
      incompleteReason: 'batch_cost_persistence_failed',
    });
    const [run] = await sql<
      Array<{
        status: string;
        error_summary: string | null;
        metadata: { batchCost?: Record<string, unknown> };
      }>
    >`
      SELECT status, error_summary, metadata
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[2]}::uuid
    `;
    expect(run?.status).toBe('failed');
    expect(run?.error_summary).toContain('batch-cost settlement');
    expect(run?.metadata.batchCost).toMatchObject({
      incompleteAccounting: true,
      incompleteReason: 'batch_cost_persistence_failed',
      attempts: {
        [attemptKey]: {
          phase: 'settlement_failed',
          incompleteAccounting: true,
          incompleteReason: 'batch_cost_persistence_failed',
        },
      },
    });
  });

  test('reconciles an orphaned marker after terminal worker loss', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[2],
      provider: 'fpl',
      lane: 'entry-sync',
      scope: 'entry-results',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
    });
    const attemptKey = 'entry-sync|entry-results|orphaned|1|none|execution-1';
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[2], {
      attemptKey,
      batchId: 'orphaned',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt: 1,
      payload: { startedAt: '2026-08-09T00:00:00.000Z' },
    });

    expect(
      await syncOperationsRepository.reconcileBatchCostTerminalFailure(RUN_IDS[2], {
        batchId: 'orphaned',
        attempt: 1,
        error: new Error('Bull exhausted after worker loss'),
      }),
    ).toBe(true);

    const [item] = await sql<Array<{ status: string; phase: string; incompleteReason: string }>>`
      SELECT status,
             normalized_payload->>'phase' AS phase,
             normalized_payload->>'incompleteReason' AS "incompleteReason"
      FROM ops.sync_items
      WHERE run_id = ${RUN_IDS[2]}::uuid
        AND resource_type = 'batch-cost'
        AND resource_id = ${attemptKey}
    `;
    expect(item).toEqual({
      status: 'failed',
      phase: 'settlement_failed',
      incompleteReason: 'worker_terminal_failure',
    });
    const [run] = await sql<
      Array<{
        status: string;
        completed_items: number;
        failed_items: number;
        skipped_items: number;
      }>
    >`
      SELECT status, completed_items, failed_items, skipped_items
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[2]}::uuid
    `;
    expect(run).toEqual({
      status: 'failed',
      completed_items: 0,
      failed_items: 1,
      skipped_items: 0,
    });
  });

  test('preserves incomplete accounting evidence after a later settlement', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[0],
      provider: 'fpl',
      lane: 'entry-sync',
      scope: 'entry-results',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
    });
    const marker = (attempt: number) => ({
      attemptKey: `entry-sync|entry-results|incomplete-evidence|${attempt}|none`,
      batchId: 'incomplete-evidence',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt,
    });
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
      ...marker(1),
      payload: { startedAt: '2026-08-09T00:00:00.000Z' },
    });
    await syncOperationsRepository.reconcileBatchCostTerminalFailure(RUN_IDS[0], {
      batchId: 'incomplete-evidence',
      attempt: 1,
      error: new Error('worker exited after provider request'),
    });
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
      ...marker(2),
      payload: { startedAt: '2026-08-09T00:00:01.000Z' },
    });
    await syncOperationsRepository.recordBatchCost(RUN_IDS[0], {
      ...marker(2),
      complete: true,
      payload: { logicalRequests: 1 },
    });

    const [run] = await sql<Array<{ metadata: { batchCost?: Record<string, unknown> } }>>`
      SELECT metadata
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(run?.metadata.batchCost).toMatchObject({
      incompleteAccounting: true,
      incompleteReason: 'worker_terminal_failure',
    });
  });

  test('sets failure counters when the first batch settlement fails', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[1],
      provider: 'fpl',
      lane: 'entry-sync',
      scope: 'entry-results',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
    });
    const input = {
      attemptKey: 'entry-sync|entry-results|first-failure|1|none|execution-1',
      batchId: 'first-failure',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt: 1,
    } as const;
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[1], {
      ...input,
      payload: { startedAt: '2026-08-09T00:00:00.000Z' },
    });
    await syncOperationsRepository.recordBatchCost(RUN_IDS[1], {
      ...input,
      complete: false,
      payload: { logicalRequests: 1 },
    });
    const [run] = await sql<
      Array<{
        status: string;
        completed_items: number;
        failed_items: number;
        skipped_items: number;
      }>
    >`
      SELECT status, completed_items, failed_items, skipped_items
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[1]}::uuid
    `;
    expect(run).toEqual({
      status: 'failed',
      completed_items: 0,
      failed_items: 1,
      skipped_items: 0,
    });
  });

  test('does not close an orphan marker while a newer attempt is running', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[0],
      provider: 'fpl',
      lane: 'entry-sync',
      scope: 'entry-results',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
    });
    const marker = (attempt: number) => ({
      attemptKey: `entry-sync|entry-results|orphan-fence|${attempt}|none|execution-${attempt}`,
      batchId: 'orphan-fence',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt,
      payload: { startedAt: `2026-08-09T00:00:0${attempt}.000Z` },
    });
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], marker(1));
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], marker(2));
    expect(
      await syncOperationsRepository.reconcileBatchCostTerminalFailure(RUN_IDS[0], {
        batchId: 'orphan-fence',
        attempt: 1,
        error: new Error('first worker lost'),
      }),
    ).toBe(true);
    const sql = await getDbClient();
    const [running] = await sql<Array<{ status: string }>>`
      SELECT status FROM ops.sync_runs WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(running?.status).toBe('running');
  });

  test('fences a late failure behind a newer batch attempt', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);

    const attempt = (number: number) => ({
      attemptKey: `entry-sync|entry-results|fenced-batch|${number}|4`,
      batchId: 'fenced-batch',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt: number,
    });
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
      ...attempt(1),
      payload: { startedAt: '2026-08-09T00:00:00.000Z' },
    });
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[0], {
      ...attempt(2),
      payload: { startedAt: '2026-08-09T00:00:01.000Z' },
    });

    await syncOperationsRepository.recordBatchCost(RUN_IDS[0], {
      ...attempt(1),
      complete: false,
      payload: { logicalRequests: 1 },
    });
    const [running] = await sql<Array<{ status: string }>>`
      SELECT status
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(running?.status).toBe('running');

    await syncOperationsRepository.recordBatchCost(RUN_IDS[0], {
      ...attempt(2),
      complete: true,
      payload: { logicalRequests: 1 },
    });
    const [completed] = await sql<Array<{ status: string }>>`
      SELECT status
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(completed?.status).toBe('completed');
  });

  test('does not reopen a failed batch-cost ledger for a stale settlement', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[1],
      provider: 'fpl',
      lane: 'data-sync',
      scope: 'player-values',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
      metadata: { test: 'stale-batch-settlement' },
    });
    const attempt = (number: number) => ({
      attemptKey: `data-sync|player-values|stale-batch|${number}|none`,
      batchId: 'stale-batch',
      parentRunId: null,
      releaseSha: 'test-release',
      attempt: number,
    });

    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[1], {
      ...attempt(2),
      payload: { startedAt: '2026-08-09T00:00:02.000Z' },
    });
    await syncOperationsRepository.recordBatchCost(RUN_IDS[1], {
      ...attempt(2),
      complete: false,
      payload: { logicalRequests: 1 },
    });
    const [failed] = await sql<Array<{ status: string }>>`
      SELECT status FROM ops.sync_runs WHERE run_id = ${RUN_IDS[1]}::uuid
    `;
    expect(failed?.status).toBe('failed');

    // This is the same ensure/start call made by a delayed attempt. It must
    // not reactivate the ledger before the attempt fence is evaluated.
    await syncOperationsRepository.startRun({
      runId: RUN_IDS[1],
      provider: 'fpl',
      lane: 'data-sync',
      scope: 'player-values',
      season,
      mode: 'batch-cost',
      trigger: 'batch-cost',
      metadata: { test: 'stale-batch-settlement', delayed: true },
    });
    await syncOperationsRepository.recordBatchCostStart(RUN_IDS[1], {
      ...attempt(1),
      payload: { startedAt: '2026-08-09T00:00:01.000Z' },
    });
    await syncOperationsRepository.recordBatchCost(RUN_IDS[1], {
      ...attempt(1),
      complete: false,
      payload: { logicalRequests: 1 },
    });
    const [stillFailed] = await sql<Array<{ status: string }>>`
      SELECT status FROM ops.sync_runs WHERE run_id = ${RUN_IDS[1]}::uuid
    `;
    expect(stillFailed?.status).toBe('failed');
  });

  test('uses wall-clock completion time inside a long mutation transaction', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);

    await withMutationScopes(
      { queueName: 'data-sync', jobName: 'player-values', jobId: RUN_IDS[0] },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const startedAt = new Date();
        await syncOperationsRepository.startRun({
          runId: RUN_IDS[0],
          provider: 'fpl',
          lane: 'market',
          scope: 'integration-contract',
          season,
          mode: 'publication',
          trigger: 'test',
          expectedItems: 1,
          startedAt,
        });
        await syncOperationsRepository.finishRun(RUN_IDS[0], {
          status: 'published',
          completedItems: 1,
          dataChanged: true,
        });
      },
    );

    const rows = await sql<Array<{ started_at: string; completed_at: string | null }>>`
      SELECT started_at, completed_at
      FROM ops.sync_runs
      WHERE run_id = ${RUN_IDS[0]}::uuid
    `;
    expect(rows[0]?.completed_at).not.toBeNull();
    expect(Date.parse(rows[0]!.completed_at!)).toBeGreaterThanOrEqual(
      Date.parse(rows[0]!.started_at),
    );
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

  test('fences a delayed Core activation by provider source time', async () => {
    const season = await seasonRepository.requireByCode(TEST_SEASON_CODE);
    await startRun(RUN_IDS[0], season);
    await startRun(RUN_IDS[1], season);
    await startRun(RUN_IDS[2], season);

    const current = await syncOperationsRepository.preparePublication({
      publicationId: PUBLICATION_IDS[0],
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[0],
    });
    await syncOperationsRepository.activatePublication({
      publicationId: current.publicationId,
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[0],
      manifest: publicationManifest(
        current.publicationId,
        current.revision,
        season,
        '2026-08-09T01:05:00.000Z',
      ),
    });

    const delayed = await syncOperationsRepository.preparePublication({
      publicationId: PUBLICATION_IDS[1],
      dataset: 'fpl:core',
      season,
      sourceRunId: RUN_IDS[1],
    });
    await expectDatabaseErrorCode(
      syncOperationsRepository.activatePublication({
        publicationId: delayed.publicationId,
        dataset: 'fpl:core',
        season,
        sourceRunId: RUN_IDS[1],
        manifest: publicationManifest(
          delayed.publicationId,
          delayed.revision,
          season,
          '2026-08-09T01:04:00.000Z',
        ),
      }),
      'CORE_SNAPSHOT_STALE_SOURCE',
    );

    expect(await syncOperationsRepository.findActivePublication('fpl:core', season)).toEqual({
      publicationId: current.publicationId,
      revision: current.revision,
      status: 'active',
    });
  });
});
