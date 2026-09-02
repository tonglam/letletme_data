import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import {
  isAuthoritativeUnrankedDeletedEntryResult,
  isAuthoritativeUnrankedFirstEventResult,
  isRetryableMyFplCaptureContention,
  isMatchingProvisionalMyFplPublication,
  isMyFplSnapshotRedisManifestForPublication,
  myFplSnapshotRedisManifestKey,
  serializeMyFplSnapshotCapture,
  resolveMyFplSnapshotCoverageState,
  getMyFplSnapshotTimeliness,
  projectedEventAutoSubPoints,
  type MyFplSnapshotPublication,
  type MyFplSnapshotRedisManifest,
} from '../../src/services/my-fpl-snapshot-publication.service';
import { normalizeAuthoritativeUnrankedEventRank } from '../../src/domain/entry-score';

const migration = readFileSync('migrations/0036_my_fpl_daily_snapshot_publications.sql', 'utf8');
const eligibilityMigration = readFileSync(
  'migrations/0064_my_fpl_entry_eligibility_counts.sql',
  'utf8',
);
const integrityMigration = readFileSync('migrations/0088_my_fpl_integrity_contract.sql', 'utf8');
const resultPicksMigration = readFileSync('migrations/0055_entry_event_result_picks.sql', 'utf8');
const retainedRevisionMigration = readFileSync(
  'migrations/0038_my_fpl_retained_revision_reads.sql',
  'utf8',
);
const publicationService = readFileSync(
  'src/services/my-fpl-snapshot-publication.service.ts',
  'utf8',
);
const governanceService = readFileSync('src/services/data-governance.service.ts', 'utf8');
const scheduler = readFileSync('src/scheduler/job-registry.ts', 'utf8');
const maintenanceJobs = readFileSync('src/jobs/maintenance.jobs.ts', 'utf8');
const worker = readFileSync('src/workers/maintenance.worker.ts', 'utf8');
const schedulerObligations = readFileSync('src/repositories/scheduler-obligations.ts', 'utf8');
const entryWorker = readFileSync('src/workers/entry-sync.worker.ts', 'utf8');
const queueRunBarrier = readFileSync('src/services/queue-run-barrier.ts', 'utf8');
const transaction = readFileSync('src/db/singleton.ts', 'utf8');
const trends = readFileSync('src/services/tournament-trends-publication.service.ts', 'utf8');
const tournamentWorker = readFileSync('src/workers/tournament-sync.worker.ts', 'utf8');
const tournamentSetupService = readFileSync('src/services/tournament-setup.service.ts', 'utf8');
const tournamentTransfers = readFileSync(
  'src/services/tournament-event-transfers.service.ts',
  'utf8',
);
const deployStateMachine = readFileSync('scripts/deploy-state-machine.sh', 'utf8');

describe('My FPL daily snapshot publication contract', () => {
  test('counts projected auto-sub points before captain multipliers', () => {
    expect(
      projectedEventAutoSubPoints(
        [{ element: 7, total_points: 6 }],
        new Map([[7, { autoSub: true, effectiveMultiplier: 2 }]]),
      ),
    ).toBe(6);
  });

  test('persists late-entry eligibility separately from the eligible denominator', () => {
    expect(eligibilityMigration).toContain('not_applicable_entry_count');
    expect(eligibilityMigration).toContain('snapshot_entry.is_empty');
    expect(eligibilityMigration).toContain(
      'expected_entry_count = captured_counts.eligible_entry_count',
    );
    expect(eligibilityMigration).not.toContain('updated_at = clock_timestamp()');
    expect(publicationService).toContain('countEntryEligibility');
    expect(publicationService).toContain('notApplicableEntryCount');
  });

  test('accepts only the authoritative unranked first-event total edge', () => {
    expect(
      isAuthoritativeUnrankedFirstEventResult({
        firstScoringEvent: 1,
        eventId: 1,
        hasPreviousResult: false,
        overallPoints: 0,
        overallRank: 0,
      }),
    ).toBe(true);
    expect(
      isAuthoritativeUnrankedFirstEventResult({
        firstScoringEvent: 1,
        eventId: 1,
        hasPreviousResult: true,
        overallPoints: 0,
        overallRank: 0,
      }),
    ).toBe(false);
    expect(
      isAuthoritativeUnrankedFirstEventResult({
        firstScoringEvent: 1,
        eventId: 2,
        hasPreviousResult: false,
        overallPoints: 0,
        overallRank: 0,
      }),
    ).toBe(false);
    expect(
      isAuthoritativeUnrankedFirstEventResult({
        firstScoringEvent: 1,
        eventId: 1,
        hasPreviousResult: false,
        overallPoints: 1,
        overallRank: 0,
      }),
    ).toBe(false);
  });

  test('normalizes and accepts only the canonical deleted-entry rank sentinel', () => {
    expect(
      normalizeAuthoritativeUnrankedEventRank({
        rank: null,
        overallRank: 0,
        sourceTotalPoints: 0,
      }),
    ).toBe(0);
    expect(
      normalizeAuthoritativeUnrankedEventRank({
        rank: null,
        overallRank: 0,
        sourceTotalPoints: 56,
      }),
    ).toBeNull();
    expect(
      isAuthoritativeUnrankedDeletedEntryResult({
        entryName: 'Deleted',
        playerName: 'Deleted Player',
        identityOverallPoints: 0,
        identityOverallRank: 0,
        eventRank: 0,
        overallRank: 0,
        totalReconciles: true,
      }),
    ).toBe(true);
    expect(
      isAuthoritativeUnrankedDeletedEntryResult({
        entryName: 'A normal team',
        playerName: 'Manager',
        identityOverallPoints: 0,
        identityOverallRank: 0,
        eventRank: 0,
        overallRank: 0,
        totalReconciles: true,
      }),
    ).toBe(false);
  });

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
      notApplicableEntryCount: 0,
      expectedTournamentCount: 1,
      readyTournamentCount: 1,
      contentSha256: 'a'.repeat(64),
      scoreSource: 'FPL_EVENT_LIVE',
      livePublicationId: '00000000-0000-4000-8000-000000000001',
      liveRevision: '8',
      algorithmVersion: 'live-points-v2-algorithm-1',
      sourceMinCheckedAt: new Date('2026-08-23T02:00:00.000Z'),
      sourceMaxCheckedAt: new Date('2026-08-23T02:05:00.000Z'),
      entryScopeSha256: 'c'.repeat(64),
      tournamentScopeSha256: 'd'.repeat(64),
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
    expect(publicationService).toContain('contractVersion: 2');
    expect(publicationService).toContain('buildMyFplManagerReview');
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

  test('bounds immutable child inserts without weakening publication atomicity', () => {
    expect(publicationService).toContain('MY_FPL_SNAPSHOT_CHILD_INSERT_BATCH_SIZE = 100');
    expect(publicationService).toContain('for (const entryBatch of batches(');
    expect(publicationService).toContain('for (const tournamentBatch of batches(');
    expect(publicationService).toContain('for (const aggregateBatch of batches(');
    const quote = String.fromCharCode(39);
    expect(publicationService).toContain(
      'client.begin(' + quote + 'isolation level repeatable read' + quote,
    );
    expect(publicationService).not.toContain('JSON.stringify(entryInsertRows)}::jsonb');
    expect(publicationService).not.toContain('JSON.stringify(tournamentInsertRows)}::jsonb');
    expect(publicationService).not.toContain('JSON.stringify(aggregateInsertRows)}::jsonb');
  });

  test('uses the daily 10:45 obligation, finalization reconciliation, and outbox retry worker', () => {
    expect(scheduler).toContain('name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT');
    expect(scheduler).toContain('my-fpl-finalization');
    expect(scheduler).toContain('name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX');
    expect(scheduler).toContain('utc8DueAt(context.now, 10, 45)');
    expect(scheduler).toContain('event.finished && event.dataChecked');
    expect(worker).toContain('dispatchMyFplSnapshotPublicationOutbox');
    expect(worker).toContain('My FPL snapshot outbox left ${result.failed}');
    expect(worker).toContain('recordMyFplOutboxRedisEvidence');
    expect(worker).toContain('deliveredEvidence: result.deliveredEvidence');
    expect(worker).toContain('OUTBOX_NO_PENDING_ACTIVE_PUBLICATION');
    expect(worker).toContain('maintenanceCompletionEvidence');
    expect(publicationService).toContain('getActiveMyFplSnapshotRedisManifest');
    expect(publicationService).toContain('remaining?: number');
    expect(governanceService).toContain('retireEmptyMyFplOutboxFreshnessWindows');
  });

  test('rebuilds legacy finals and keeps provisional transfer facts on one authority', () => {
    expect(publicationService).toContain('isManagerReviewV2MyFplPublication');
    expect(worker).toContain('activeFinalUsesManagerReviewV2');
    expect(worker).toContain('activeFinalScopeMatchesCurrentReadiness');
    expect(worker).toContain('active.entryScopeSha256 === finalizationReadiness.entryScopeSha256');
    expect(worker).toContain(
      'active.notApplicableEntryCount === finalizationReadiness.notApplicableEntryCount',
    );
    expect(worker).toContain(
      'active.tournamentScopeSha256 === finalizationReadiness.tournamentScopeSha256',
    );
    expect(scheduler).toContain('getMyFplSnapshotOperationalStatus');
    expect(scheduler).toContain('periodKey: `final-${event.id}-${checkedAt}-${scopeFence}`');
    expect(integrityMigration).toContain('expected_not_applicable_entry_count');
    expect(integrityMigration).toContain(
      'COALESCE(active.not_applicable_entry_count, 0) IS DISTINCT FROM',
    );
    expect(integrityMigration).toContain(
      'AND (entry.started_event IS NULL OR entry.started_event <= event.event_id)',
    );
    expect(integrityMigration).toContain('ON entry.season_id = event.season_id');
    expect(integrityMigration).toContain('AND NOT snapshot_entry.is_empty');
    expect(integrityMigration).toContain('YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    expect(schedulerObligations).toContain(
      'leaseOwner: sql`COALESCE(${schedulerObligationsInOps.leaseOwner}, ${randomUUID()})`',
    );
    expect(worker).toContain('const publicationForDelivery');
    expect(worker).toContain('isMyFplSnapshotRedisManifestForPublication');
    expect(publicationService).toContain('provisionalEventPointsByElement');
    expect(publicationService).toContain('Event-live publication is missing transfer points');
    expect(publicationService).toMatch(/chip\(row\.event_chip\) === 'FREE_HIT'/);
    expect(publicationService).toContain('pick.event_team_id AS team_id');
    expect(publicationService).not.toContain(
      'COALESCE(pick.event_team_id, player.team_id) AS team_id',
    );
  });

  test('replays a delivered manifest when the derived Redis pointer is lost', () => {
    expect(publicationService).toContain('requeueDeliveredMyFplSnapshotPublication');
    expect(publicationService).toMatch(/status = 'DELIVERED'/);
    expect(publicationService).toMatch(/status = 'PENDING'/);
    expect(worker).toContain('const replay = await dispatchMyFplSnapshotPublicationOutbox');
    expect(worker).toContain('Redis replay left ${replay.failed}');
    expect(worker).toContain('My FPL snapshot Redis outbox remains incomplete');
  });

  test('keeps provisional refreshes separate from the zero-provider-request finalizer', () => {
    expect(queueRunBarrier).toContain('QUEUE_RUN_WAIT_TIMEOUT_MS = 30 * 60_000');
    expect(queueRunBarrier).not.toContain('QUEUE_RUN_WAIT_TIMEOUT_MS = 10 * 60_000');
    expect(worker).toContain('renewSchedulerObligation');
    expect(worker).toContain('SCHEDULER_LEASE_HEARTBEAT_MS = 60_000');
    expect(worker).toContain('runQueueRunPhase(attemptKey');
    expect(worker).not.toContain('await Promise.all([\n          enqueueCoreSnapshotJob');
    expect(worker).toContain('eventRepository.findLatestFinalized(season)');
    expect(worker).toContain('eventId: entryInfoTargetEventId');
    expect(worker).toMatch(
      /enqueueEntryTransfersSyncJob\(season, source, \{[\s\S]{0,120}freshAfter,/,
    );
    expect(worker).toContain('assessMyFplFinalizationReadiness');
    expect(worker).toMatch(/status: 'waiting-dependencies'/);
    expect(worker).not.toContain('enqueueTournamentEventResults');
    expect(worker).not.toContain('enqueueTournamentEventPicks');
    expect(worker).not.toContain('enqueueTournamentTransfersPre');
    expect(entryWorker).toContain('findEntryIdsNeedingSourceRefresh');
    expect(tournamentWorker).toContain('job.name === TOURNAMENT_JOBS.TRANSFERS_PRE');
    expect(tournamentWorker).toContain('const freshAfter = await resolveJobFreshAfter(job)');
    expect(tournamentWorker).toContain('perEntryMutationScopes: true');
    expect(tournamentTransfers).toContain('findEntryIdsNeedingSourceRefresh');
    expect(tournamentTransfers).toContain('requiredUnits: entryIds.length');
    expect(scheduler).toMatch(/executionLanes: \['my-fpl-orchestration'\]/);
    expect(scheduler).toMatch(
      /name: 'my-fpl-finalization',[\s\S]{0,300}queueName: 'my-fpl-orchestration'/,
    );
    expect(maintenanceJobs).toMatch(/options\?\.snapshotKind === 'FINAL'/);
    expect(worker).toMatch(/'my-fpl-orchestration', 'publication-outbox'/);
    expect(tournamentSetupService).toContain(
      'Skipped global tournament materialized-view refresh during setup',
    );
    expect(tournamentSetupService).not.toContain('await refreshTournamentMaterializedViews()');
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
      notApplicableEntryCount: 0,
      expectedTournamentCount: 1,
      readyTournamentCount: 1,
      contentSha256: 'a'.repeat(64),
      scoreSource: 'FPL_EVENT_LIVE',
      livePublicationId: '00000000-0000-4000-8000-000000000001',
      liveRevision: '8',
      algorithmVersion: 'live-points-v2-algorithm-1',
      sourceMinCheckedAt: new Date('2026-08-23T02:00:00.000Z'),
      sourceMaxCheckedAt: new Date('2026-08-23T02:05:00.000Z'),
      entryScopeSha256: 'c'.repeat(64),
      tournamentScopeSha256: 'd'.repeat(64),
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
        entryScopeSha256: active.entryScopeSha256!,
        tournamentScopeSha256: active.tournamentScopeSha256!,
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
        entryScopeSha256: active.entryScopeSha256!,
        tournamentScopeSha256: active.tournamentScopeSha256!,
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
        entryScopeSha256: active.entryScopeSha256!,
        tournamentScopeSha256: active.tournamentScopeSha256!,
      }),
    ).toBe(false);
    expect(resolveMyFplSnapshotCoverageState(null, 0)).toBe('NO_PUBLICATION');
    expect(resolveMyFplSnapshotCoverageState('FINAL', 1)).toBe('IMMUTABLE_FINAL');
    expect(resolveMyFplSnapshotCoverageState('PROVISIONAL', 1)).toBe('CORRECTION_PENDING');
    expect(resolveMyFplSnapshotCoverageState('PROVISIONAL', 0)).toBe('COMPLETE');
  });

  test('requires Redis noop evidence to match every active publication field', () => {
    const publication: MyFplSnapshotPublication = {
      seasonId: 2026,
      eventId: 2,
      revision: 9,
      snapshotDate: '2026-08-25',
      sourceCheckedAt: new Date('2026-08-24T02:00:00.000Z'),
      publishedAt: new Date('2026-08-25T00:00:00.000Z'),
      kind: 'FINAL',
      expectedEntryCount: 2,
      readyEntryCount: 2,
      emptyEntryCount: 0,
      notApplicableEntryCount: 0,
      expectedTournamentCount: 1,
      readyTournamentCount: 1,
      contentSha256: 'a'.repeat(64),
      entryScopeSha256: 'b'.repeat(64),
      tournamentScopeSha256: 'c'.repeat(64),
      scoreSource: 'FPL_FINAL_RESULT',
      livePublicationId: null,
      liveRevision: null,
      algorithmVersion: null,
      sourceMinCheckedAt: new Date('2026-08-24T02:00:00.000Z'),
      sourceMaxCheckedAt: new Date('2026-08-24T02:05:00.000Z'),
    };
    const manifest: MyFplSnapshotRedisManifest = {
      dataset: 'fpl:my-fpl',
      seasonCode: '2627',
      eventId: 2,
      revision: 9,
      snapshotDate: publication.snapshotDate,
      sourceCheckedAt: publication.sourceCheckedAt.toISOString(),
      publishedAt: publication.publishedAt.toISOString(),
      kind: publication.kind,
      contentSha256: publication.contentSha256,
      expectedEntryCount: publication.expectedEntryCount,
      observedEntryCount: publication.readyEntryCount + publication.emptyEntryCount,
      expectedTournamentCount: publication.expectedTournamentCount,
      observedTournamentCount: publication.readyTournamentCount,
      entryScopeSha256: publication.entryScopeSha256!,
      tournamentScopeSha256: publication.tournamentScopeSha256!,
      scoreSource: publication.scoreSource,
      livePublicationId: publication.livePublicationId,
      liveRevision: publication.liveRevision,
      algorithmVersion: publication.algorithmVersion,
      sourceMinCheckedAt: publication.sourceMinCheckedAt!.toISOString(),
      sourceMaxCheckedAt: publication.sourceMaxCheckedAt!.toISOString(),
    };
    expect(isMyFplSnapshotRedisManifestForPublication(manifest, publication, '2627', 2)).toBe(true);
    expect(
      isMyFplSnapshotRedisManifestForPublication(
        { ...manifest, contentSha256: 'd'.repeat(64) },
        publication,
        '2627',
        2,
      ),
    ).toBe(false);
    expect(
      isMyFplSnapshotRedisManifestForPublication(
        { ...manifest, observedEntryCount: 1 },
        publication,
        '2627',
        2,
      ),
    ).toBe(false);
    expect(
      isMyFplSnapshotRedisManifestForPublication(
        { ...manifest, sourceCheckedAt: '2026-08-24T02:00:01.000Z' },
        publication,
        '2627',
        2,
      ),
    ).toBe(false);
  });

  test('fences FINAL readiness and capture on durable historical/player evidence', () => {
    expect(publicationService).toContain('fresh_points_count');
    expect(publicationService).toContain('history_ready_count');
    expect(publicationService).toContain('past_seasons_checked_at');
    expect(publicationService).toContain('stats.updated_at >= ${dataCheckedAt}::timestamptz');
    expect(publicationService).toContain(
      'final player stats are older than data_checked_at for event',
    );
    expect(publicationService).toContain(
      'points result is stale or inconsistent with the final entry result',
    );
  });

  test('does not cast a nullable tournament group enum through an invalid empty value', () => {
    expect(publicationService).toContain(String.raw`group_mode IS DISTINCT FROM 'points_races'`);
    expect(publicationService).not.toContain(String.raw`COALESCE(group_mode, '')`);
  });

  test('fails Redis delivery when the active pointer is not the captured publication', () => {
    expect(worker).toContain(
      'const activeRedisManifest = await getActiveMyFplSnapshotRedisManifest',
    );
    expect(worker).toContain(
      'My FPL snapshot Redis pointer does not match PostgreSQL publication revision',
    );
    expect(publicationService).toContain('season.season_code AS canonical_season_code');
    expect(publicationService).toContain(
      'myFplSnapshotRedisManifestKey(canonicalSeasonCode, currentPublication.eventId)',
    );
  });

  test('keeps the daily provisional freshness boundary deterministic', () => {
    expect(
      getMyFplSnapshotTimeliness('2026-08-31', 'PROVISIONAL', new Date('2026-09-01T03:59:59.000Z')),
    ).toBe('CURRENT');
    expect(
      getMyFplSnapshotTimeliness('2026-08-31', 'PROVISIONAL', new Date('2026-09-01T04:00:00.000Z')),
    ).toBe('STALE');
    expect(
      getMyFplSnapshotTimeliness('2026-08-31', 'FINAL', new Date('2026-09-05T00:00:00.000Z')),
    ).toBe('CURRENT');
    expect(getMyFplSnapshotTimeliness(null, null, new Date('2026-09-01T00:00:00.000Z'))).toBe(
      'STALE',
    );
  });

  test('checks the Redis outbox manifest against the locked PostgreSQL publication', () => {
    expect(publicationService).toContain('publication.entry_scope_sha256');
    expect(publicationService).toContain(
      'My FPL Redis manifest does not match the active PostgreSQL publication',
    );
    expect(publicationService).toContain('mapMyFplPublication(ownership[0])');
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
      'remove_exact_stopped_container api\n    remove_stale_api_run_containers\n    wait_for_port_3000_free',
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
