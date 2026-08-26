import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import {
  isRetryableMyFplCaptureContention,
  isMatchingProvisionalMyFplPublication,
  myFplSnapshotRedisManifestKey,
  serializeMyFplSnapshotCapture,
  resolveMyFplSnapshotCoverageState,
  type MyFplSnapshotPublication,
} from '../../src/services/my-fpl-snapshot-publication.service';

const migration = readFileSync('migrations/0036_my_fpl_daily_snapshot_publications.sql', 'utf8');
const resultPicksMigration = readFileSync('migrations/0055_entry_event_result_picks.sql', 'utf8');
const retainedRevisionMigration = readFileSync(
  'migrations/0038_my_fpl_retained_revision_reads.sql',
  'utf8',
);
const publicationService = readFileSync(
  'src/services/my-fpl-snapshot-publication.service.ts',
  'utf8',
);
const scheduler = readFileSync('src/scheduler/job-registry.ts', 'utf8');
const worker = readFileSync('src/workers/maintenance.worker.ts', 'utf8');
const entryWorker = readFileSync('src/workers/entry-sync.worker.ts', 'utf8');
const queueRunBarrier = readFileSync('src/services/queue-run-barrier.ts', 'utf8');
const transaction = readFileSync('src/db/singleton.ts', 'utf8');
const trends = readFileSync('src/services/tournament-trends-publication.service.ts', 'utf8');
const tournamentWorker = readFileSync('src/workers/tournament-sync.worker.ts', 'utf8');
const tournamentTransfers = readFileSync(
  'src/services/tournament-event-transfers.service.ts',
  'utf8',
);
const deployStateMachine = readFileSync('scripts/deploy-state-machine.sh', 'utf8');

describe('My FPL daily snapshot publication contract', () => {
  test('serializes in-process captures without hiding a newer data revision', async () => {
    const publication: MyFplSnapshotPublication = {
      seasonId: 2026,
      eventId: 1,
      revision: 1,
      snapshotDate: '2026-08-24',
      sourceCheckedAt: new Date('2026-08-23T02:00:00.000Z'),
      publishedAt: new Date('2026-08-24T00:00:01.000Z'),
      kind: 'PROVISIONAL',
      expectedEntryCount: 1,
      readyEntryCount: 1,
      emptyEntryCount: 0,
      expectedTournamentCount: 1,
      readyTournamentCount: 1,
      contentSha256: 'a'.repeat(64),
      scoreSource: 'FPL_EVENT_LIVE',
      livePublicationId: '00000000-0000-4000-8000-000000000001',
      liveRevision: '8',
      algorithmVersion: 'fpl-projected-autosubs-v1',
      sourceMinCheckedAt: new Date('2026-08-23T02:00:00.000Z'),
      sourceMaxCheckedAt: new Date('2026-08-23T02:05:00.000Z'),
    };
    let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updatedPublication = { ...publication, revision: 2, contentSha256: 'b'.repeat(64) };
    const operation = async () => {
      calls += 1;
      if (calls === 1) {
        await barrier;
        return { status: 'published' as const, publication };
      }
      return { status: 'published' as const, publication: updatedPublication };
    };

    const first = serializeMyFplSnapshotCapture('same-event', operation);
    const second = serializeMyFplSnapshotCapture('same-event', operation);
    expect(first).not.toBe(second);
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    const [leader, follower] = await Promise.all([first, second]);
    expect(leader).toEqual({ status: 'published', publication });
    expect(follower).toEqual({ status: 'published', publication: updatedPublication });
    expect(calls).toBe(2);

    const failed = serializeMyFplSnapshotCapture('failed-capture', async () => {
      throw new Error('capture failed');
    });
    const retry = serializeMyFplSnapshotCapture('failed-capture', async () => {
      calls += 1;
      return { status: 'noop', publication };
    });
    await expect(failed).rejects.toThrow('capture failed');
    await expect(retry).resolves.toEqual({ status: 'noop', publication });
    await expect(
      serializeMyFplSnapshotCapture('fresh-failure', async () => {
        throw new Error('capture failed');
      }),
    ).rejects.toThrow('capture failed');
    await serializeMyFplSnapshotCapture('fresh-failure', async () => {
      calls += 1;
      return { status: 'noop', publication };
    });
    expect(calls).toBe(4);
  });

  test('keeps one active revision and a durable Redis handoff per gameweek', () => {
    expect(migration).toContain('my_fpl_snapshot_publications_active_key');
    expect(migration).toContain('my_fpl_snapshot_publication_outbox');
    expect(migration).toContain('my_fpl_snapshot_publication_outbox_revision_key');
    expect(migration).toContain('status text NOT NULL DEFAULT');
    expect(migration).toContain('DELIVERED');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(publicationService).toContain('24 * 60 * 60_000');
    expect(publicationService).toContain('publication.active = true');
    expect(publicationService).toContain('Publication is no longer the active My FPL revision');
  });

  test('keeps pinned superseded revisions readable for the bounded retention window', () => {
    expect(retainedRevisionMigration).toMatch(
      /updated_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'/,
    );
    expect(retainedRevisionMigration).toContain('my_fpl_snapshot_publications_retention_idx');
    expect(retainedRevisionMigration).toContain(
      'CREATE POLICY my_fpl_snapshot_publications_graphql_readable',
    );
    expect(retainedRevisionMigration).toContain(
      'CREATE POLICY my_fpl_snapshot_entries_graphql_readable',
    );
    expect(retainedRevisionMigration).toContain(
      'CREATE POLICY my_fpl_snapshot_tournament_rows_graphql_readable',
    );
    expect(retainedRevisionMigration).toContain(
      'CREATE POLICY my_fpl_snapshot_tournament_aggregates_graphql_readable',
    );
    expect(retainedRevisionMigration).not.toMatch(/USING\s*\(\s*true\s*\)/i);
    expect(retainedRevisionMigration).not.toMatch(
      /published_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours'/,
    );
  });

  test('captures official auto substitutions without inferring Bench Boost', () => {
    expect(publicationService).toContain('automatic_substitutions');
    expect(publicationService).toContain('element_in');
    expect(publicationService).toContain('entryPicks.length === 15');
    expect(publicationService).toContain('entryPicks.every((pick) => pick.total_points !== null');
    expect(publicationService).toContain('same transaction as the immutable');
  });

  test('binds final picks to the immutable result row', () => {
    expect(resultPicksMigration).toContain('ADD COLUMN IF NOT EXISTS event_picks jsonb');
    expect(resultPicksMigration).toContain('entry_event_results_event_picks_array');
    expect(publicationService).toContain('result.event_picks');
    expect(publicationService).toContain('overlayFinalResultPicks');
    expect(publicationService).toContain('final result picks are incomplete or changed for event');
  });

  test('serializes publication timestamps for the production postgres adapter', () => {
    expect(publicationService).toContain('const nowIso = now.toISOString()');
    expect(publicationService).toContain(
      'const sourceCheckedAtIso = sourceCheckedAt.toISOString()',
    );
    expect(publicationService).toContain('const supersededBeforeIso = new Date(');
    expect(publicationService).toContain('${sourceCheckedAtIso}::timestamptz');
    expect(publicationService).toContain('${nowIso}::timestamptz');
    expect(publicationService).toContain('${supersededBeforeIso}::timestamptz');
    expect(publicationService).toContain(
      'active = false AND updated_at < ${supersededBeforeIso}::timestamptz',
    );
    expect(publicationService).not.toContain('${sourceCheckedAt}, ${now},');
    expect(publicationService).not.toContain('${new Date(now.getTime() - 24 * 60 * 60_000)}');
  });

  test('uses the daily 10:45 obligation, finalization reconciliation, and outbox retry worker', () => {
    expect(scheduler).toContain('name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT');
    expect(scheduler).toContain('my-fpl-finalization');
    expect(scheduler).toContain('name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX');
    expect(scheduler).toContain('utc8DueAt(context.now, 10, 45)');
    expect(scheduler).toContain('event.finished && event.dataChecked');
    expect(worker).toContain('dispatchMyFplSnapshotPublicationOutbox');
    expect(worker).toContain('My FPL snapshot outbox left ${result.failed}');
  });

  test('allows the full current-season refresh barrier to settle', () => {
    expect(queueRunBarrier).toContain('QUEUE_RUN_WAIT_TIMEOUT_MS = 30 * 60_000');
    expect(queueRunBarrier).not.toContain('QUEUE_RUN_WAIT_TIMEOUT_MS = 10 * 60_000');
    expect(worker).toContain('renewSchedulerObligation');
    expect(worker).toContain('SCHEDULER_LEASE_HEARTBEAT_MS = 60_000');
    expect(worker).toContain('runQueueRunPhase(attemptKey');
    expect(worker).not.toContain('await Promise.all([\n          enqueueCoreSnapshotJob');
    expect(worker).toContain('eventRepository.findLatestFinalized(season)');
    expect(worker).toContain('eventId: entryInfoTargetEventId');
    expect(worker).toContain('const freshAfter = await resolveJobFreshAfter(job)');
    expect(worker).toMatch(
      /enqueueEntryTransfersSyncJob\(season, source, \{[\s\S]{0,120}freshAfter,/,
    );
    expect(worker).toMatch(
      /enqueueTournamentTransfersPre\(season, job\.data\.eventId, source, \{[\s\S]{0,120}freshAfter,/,
    );
    expect(entryWorker).toContain('findEntryIdsNeedingSourceRefresh');
    expect(tournamentWorker).toContain('job.name === TOURNAMENT_JOBS.TRANSFERS_PRE');
    expect(tournamentWorker).toContain('const freshAfter = await resolveJobFreshAfter(job)');
    expect(tournamentWorker).toContain('perEntryMutationScopes: true');
    expect(tournamentTransfers).toContain('findEntryIdsNeedingSourceRefresh');
    expect(tournamentTransfers).toContain('requiredUnits: entryIds.length');
  });

  test('decides same-day provisional noops only after normalized content hashing', () => {
    const contentHash = publicationService.indexOf('const contentSha256 = createHash');
    const matchingGuard = publicationService.lastIndexOf(
      'isMatchingProvisionalMyFplPublication(active',
    );
    const publicationInsert = publicationService.indexOf(
      'INSERT INTO competition.my_fpl_snapshot_publications',
    );
    expect(contentHash).toBeGreaterThan(0);
    expect(matchingGuard).toBeGreaterThan(contentHash);
    expect(publicationInsert).toBeGreaterThan(matchingGuard);
    expect(publicationService).not.toContain(
      'active.snapshotDate === snapshotDate &&\n        kind === \u0027PROVISIONAL\u0027',
    );
  });

  test('retries a fresh repeatable-read transaction when the pooler-safe lock is busy', () => {
    const helper = publicationService.slice(
      publicationService.indexOf('async function runMyFplCaptureTransaction'),
      publicationService.indexOf('type EntryIdentity'),
    );
    expect(helper).toContain('client.begin(\u0027isolation level repeatable read\u0027');
    expect(helper).toContain('pg_try_advisory_xact_lock');
    expect(helper).toContain('throw new MyFplCaptureLockBusyError()');
    expect(helper).toContain('record.code === \u002740001\u0027');
    expect(helper).toContain('my_fpl_snapshot_publications_active_key');
    expect(helper).toContain('my_fpl_snapshot_publications_idempotency_key');
    expect(publicationService).toContain('MY_FPL_CAPTURE_LOCK_WAIT_TIMEOUT_MS = 2 * 60_000');
    expect(publicationService).toContain('MAX_MY_FPL_CAPTURE_COMMIT_CONFLICT_RETRIES = 3');
    expect(helper).toContain('let lockWaitRemainingMs = MY_FPL_CAPTURE_LOCK_WAIT_TIMEOUT_MS');
    expect(helper).toContain('let commitBoundaryConflictRetries = 0');
    expect(helper).toContain('let idempotencyConflictRetries = 0');
    expect(helper.indexOf('const lockAttemptStartedAt = Date.now()')).toBeLessThan(
      helper.indexOf('client.begin('),
    );
    expect(helper).toContain('lockWaitRemainingMs -= Date.now() - lockAttemptStartedAt');
    expect(helper).toMatch(/contention === 'idempotency'/);
    expect(helper).toContain('idempotencyConflictRetries >= 1');
    expect(publicationService).toContain('loadPublicationByIdempotencyKey');
    expect(helper).not.toContain('const deadline = Date.now()');
    expect(helper).not.toContain('pg_advisory_lock(');
    expect(helper).not.toContain('client.reserve()');
  });

  test('retries only the active-publication unique conflict from a stale snapshot', () => {
    expect(isRetryableMyFplCaptureContention({ code: '40001' })).toBe(true);
    expect(
      isRetryableMyFplCaptureContention({
        code: '23505',
        constraint_name: 'my_fpl_snapshot_publications_active_key',
      }),
    ).toBe(true);
    expect(
      isRetryableMyFplCaptureContention({
        code: '23505',
        constraint_name: 'my_fpl_snapshot_publications_idempotency_key',
      }),
    ).toBe(true);
    expect(
      isRetryableMyFplCaptureContention({
        cause: {
          code: '23505',
          constraint: 'my_fpl_snapshot_publications_active_key',
        },
      }),
    ).toBe(true);
    expect(
      isRetryableMyFplCaptureContention({
        code: '23505',
        constraint_name: 'some_other_unique_constraint',
      }),
    ).toBe(false);
  });

  test('reuses only an identical provisional revision and reports coverage state', () => {
    const active: MyFplSnapshotPublication = {
      seasonId: 2026,
      eventId: 20,
      revision: 7,
      snapshotDate: '2026-08-23',
      sourceCheckedAt: new Date('2026-08-23T02:00:00.000Z'),
      publishedAt: new Date('2026-08-23T02:05:00.000Z'),
      kind: 'PROVISIONAL',
      expectedEntryCount: 10,
      readyEntryCount: 10,
      emptyEntryCount: 0,
      expectedTournamentCount: 1,
      readyTournamentCount: 1,
      contentSha256: 'a'.repeat(64),
      scoreSource: 'FPL_EVENT_LIVE',
      livePublicationId: '00000000-0000-4000-8000-000000000001',
      liveRevision: '8',
      algorithmVersion: 'fpl-projected-autosubs-v1',
      sourceMinCheckedAt: new Date('2026-08-23T02:00:00.000Z'),
      sourceMaxCheckedAt: new Date('2026-08-23T02:05:00.000Z'),
    };
    expect(
      isMatchingProvisionalMyFplPublication(active, {
        kind: 'PROVISIONAL',
        snapshotDate: active.snapshotDate,
        contentSha256: active.contentSha256,
        scoreSource: active.scoreSource,
        livePublicationId: active.livePublicationId,
        liveRevision: active.liveRevision,
        algorithmVersion: active.algorithmVersion,
        sourceMinCheckedAt: active.sourceMinCheckedAt!.toISOString(),
        sourceMaxCheckedAt: active.sourceMaxCheckedAt!.toISOString(),
      }),
    ).toBe(true);
    expect(
      isMatchingProvisionalMyFplPublication(active, {
        kind: 'PROVISIONAL',
        snapshotDate: active.snapshotDate,
        contentSha256: 'b'.repeat(64),
        scoreSource: active.scoreSource,
        livePublicationId: active.livePublicationId,
        liveRevision: active.liveRevision,
        algorithmVersion: active.algorithmVersion,
        sourceMinCheckedAt: active.sourceMinCheckedAt!.toISOString(),
        sourceMaxCheckedAt: active.sourceMaxCheckedAt!.toISOString(),
      }),
    ).toBe(false);
    expect(
      isMatchingProvisionalMyFplPublication(active, {
        kind: 'FINAL',
        snapshotDate: active.snapshotDate,
        contentSha256: active.contentSha256,
        scoreSource: 'FPL_FINAL_RESULT',
        livePublicationId: null,
        liveRevision: null,
        algorithmVersion: null,
        sourceMinCheckedAt: active.sourceMinCheckedAt!.toISOString(),
        sourceMaxCheckedAt: active.sourceMaxCheckedAt!.toISOString(),
      }),
    ).toBe(false);
    expect(resolveMyFplSnapshotCoverageState(null, 0)).toBe('NO_PUBLICATION');
    expect(resolveMyFplSnapshotCoverageState('FINAL', 1)).toBe('IMMUTABLE_FINAL');
    expect(resolveMyFplSnapshotCoverageState('PROVISIONAL', 1)).toBe('CORRECTION_PENDING');
    expect(resolveMyFplSnapshotCoverageState('PROVISIONAL', 0)).toBe('COMPLETE');
  });

  test('serializes tournament result and transfer writes', () => {
    const resultPhase = 'if (requiredResultEntryIds.length > 0)';
    const transferPhase = 'if (plan.requiredTransferEntryIds.length > 0)';
    expect(tournamentWorker).toContain('perEntryMutationScopes: true');
    const source = readFileSync('src/services/tournament-event-results.service.ts', 'utf8');
    expect(source).toContain(resultPhase);
    expect(source).toContain(transferPhase);
    expect(source.indexOf(resultPhase)).toBeLessThan(source.indexOf(transferPhase));
    expect(source).toContain('advisory-lock cycle');
  });

  test('keeps trend publication repeatable-read safe across savepoints', () => {
    const repeatableRead = 'repeatable read';
    expect(transaction).toContain(`options: { isolationLevel?: '${repeatableRead}' } = {}`);
    expect(transaction).toContain('client.begin(beginOptions, operation)');
    expect(trends).toContain(`isolationLevel: '${repeatableRead}'`);
    expect(trends).not.toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(tournamentWorker).not.toContain('TREND_PUBLICATION_JOB_NAMES');
  });

  test('waits through transient API port-proxy teardown before rejecting an unknown listener', () => {
    expect(deployStateMachine).toContain(
      'remove_exact_stopped_container api\n    wait_for_port_3000_free',
    );
    expect(deployStateMachine).not.toContain(
      'remove_exact_stopped_container api\n    assert_port_3000_free',
    );
  });

  test('names Redis manifests by season and event', () => {
    expect(myFplSnapshotRedisManifestKey('2627', 1)).toBe('llm:data:fpl:my-fpl:2627:1:active');
    expect(() => myFplSnapshotRedisManifestKey('26', 1)).toThrow();
    expect(() => myFplSnapshotRedisManifestKey('2627', 0)).toThrow();
  });
});
