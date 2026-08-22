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

  test('names Redis manifests by season and event', () => {
    expect(myFplSnapshotRedisManifestKey('2627', 1)).toBe('llm:data:fpl:my-fpl:2627:1:active');
    expect(() => myFplSnapshotRedisManifestKey('26', 1)).toThrow();
    expect(() => myFplSnapshotRedisManifestKey('2627', 0)).toThrow();
  });
});
