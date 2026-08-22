import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import { myFplSnapshotRedisManifestKey } from '../../src/services/my-fpl-snapshot-publication.service';

const migration = readFileSync('migrations/0036_my_fpl_daily_snapshot_publications.sql', 'utf8');
const publicationService = readFileSync(
  'src/services/my-fpl-snapshot-publication.service.ts',
  'utf8',
);
const scheduler = readFileSync('src/scheduler/job-registry.ts', 'utf8');
const worker = readFileSync('src/workers/maintenance.worker.ts', 'utf8');
const transaction = readFileSync('src/db/singleton.ts', 'utf8');
const trends = readFileSync('src/services/tournament-trends-publication.service.ts', 'utf8');
const tournamentWorker = readFileSync('src/workers/tournament-sync.worker.ts', 'utf8');
const deployStateMachine = readFileSync('scripts/deploy-state-machine.sh', 'utf8');

describe('My FPL daily snapshot publication contract', () => {
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

  test('captures official auto substitutions without inferring Bench Boost', () => {
    expect(publicationService).toContain('automatic_substitutions');
    expect(publicationService).toContain('element_in');
    expect(publicationService).toContain('entryPicks.length === 15');
    expect(publicationService).toContain('entryPicks.every((pick) => pick.total_points !== null');
    expect(publicationService).toContain('same transaction as the immutable');
  });

  test('uses the daily 10:45 obligation, finalization reconciliation, and outbox retry worker', () => {
    expect(scheduler).toContain('name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT');
    expect(scheduler).toContain('my-fpl-finalization');
    expect(scheduler).toContain('name: MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX');
    expect(scheduler).toContain('utc8DueAt(context.now, 10, 45)');
    expect(scheduler).toContain('finished && lifecycle.dataChecked');
    expect(worker).toContain('dispatchMyFplSnapshotPublicationOutbox');
  });

  test('allows the full current-season refresh barrier to settle', () => {
    expect(worker).toContain('const MY_FPL_REFRESH_WAIT_TIMEOUT_MS = 30 * 60_000');
    expect(worker).not.toContain('const MY_FPL_REFRESH_WAIT_TIMEOUT_MS = 10 * 60_000');
    expect(worker).toContain('renewSchedulerObligation');
    expect(worker).toContain('SCHEDULER_LEASE_HEARTBEAT_MS = 60_000');
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
