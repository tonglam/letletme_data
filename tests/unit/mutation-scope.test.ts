import { describe, expect, it } from 'bun:test';

import {
  resolveMutationScopes,
  tournamentSetupBackfillEventScopes,
  tournamentSetupLifecycleScope,
  tournamentSetupRebuildScopes,
} from '../../src/domain/mutation-scope';

describe('resolveMutationScopes', () => {
  it('normalizes tiered queue names', () => {
    const scopes = resolveMutationScopes({
      queueName: 'live-data-p0',
      jobName: 'event-lives-db',
      eventId: 33,
    });
    expect(scopes).toEqual(['data-core:fixtures', 'live-snapshot:event:33']);
  });

  it.each([
    'event-lives-cache',
    'event-lives-db',
    'live-fixture-cache',
    'live-bonus-cache',
    'live-scores',
  ])('gives legacy live view job %s the complete snapshot scopes', (jobName) => {
    expect(resolveMutationScopes({ queueName: 'live-data-p0', jobName, eventId: 33 })).toEqual([
      'data-core:fixtures',
      'live-snapshot:event:33',
    ]);
  });

  it('maps legacy fixture jobs to the complete core snapshot scopes', () => {
    const snapshotScopes = resolveMutationScopes({
      queueName: 'live-data-p0',
      jobName: 'live-snapshot',
      eventId: 33,
    });
    const fixtureScopes = resolveMutationScopes({
      queueName: 'data-sync-p1',
      jobName: 'fixtures',
      eventId: 33,
    });

    expect(snapshotScopes).toContain('data-core:fixtures');
    expect(snapshotScopes).toContain('live-snapshot:event:33');
    expect(fixtureScopes).toEqual([
      'data-core:events',
      'data-core:teams',
      'data-core:players',
      'data-core:phases',
      'data-core:fixtures',
    ]);
  });

  it('keeps partial price updates inside the complete legacy player alias scope', () => {
    const fullSync = resolveMutationScopes({ queueName: 'data-sync-p1', jobName: 'players' });
    const priceSync = resolveMutationScopes({
      queueName: 'data-sync-p1',
      jobName: 'player-prices',
    });

    expect(fullSync).toContain('data-core:players');
    expect(priceSync).toEqual(['data-core:players']);
  });

  it('adds event-scoped conflict groups for league event results', () => {
    const scopes = resolveMutationScopes({
      queueName: 'league-sync-p3',
      jobName: 'league-event-results',
      eventId: 33,
      tournamentId: 1001,
    });
    expect(scopes).toContain('entry-event-results:event:33');
    expect(scopes).toContain('league-event-results:event:33');
    expect(scopes).toContain('league-event-results:tournament:1001');
  });

  it('does not lock the whole setup job by default (phase locks are explicit)', () => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-setup-p0',
      jobName: 'tournament-setup',
      tournamentId: 789,
    });
    expect(scopes).toEqual([]);
  });

  it('exposes rebuild, backfill, and lifecycle scopes for setup phases', () => {
    expect(tournamentSetupRebuildScopes(789)).toEqual([
      'tournament-structure:tournament:789',
      'tournament-structure:global',
    ]);
    expect(tournamentSetupBackfillEventScopes(33)).toEqual([
      'tournament-structure:event:33',
      'tournament-structure:global',
    ]);
    expect(tournamentSetupLifecycleScope(789)).toBe('tournament-setup:tournament:789');
  });

  it('keeps tournament selection stats serialized with tournament event mutations', () => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-sync-p2',
      jobName: 'tournament-selection-stats',
      eventId: 35,
    });
    expect(scopes).toEqual(['tournament-event-mutations:event:35']);
  });

  it.each(['tournament-points-race', 'tournament-battle-race', 'tournament-knockout'])(
    'gives %s the shared global structure scope (FP-07)',
    (jobName) => {
      const scopes = resolveMutationScopes({
        queueName: 'tournament-sync',
        jobName,
        eventId: 33,
      });
      expect(scopes).toContain('tournament-structure:global');
      expect(scopes).toContain('tournament-structure:event:33');
    },
  );

  it('narrows tournament event results to per-table entry scopes (FP-14h)', () => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-sync-p2',
      jobName: 'tournament-event-results',
      eventId: 35,
    });
    expect(scopes).toContain('entry-event-picks:event:35');
    expect(scopes).toContain('entry-event-transfers:event:35');
    expect(scopes).toContain('entry-event-results:event:35');
    expect(scopes).toContain('tournament-event-results:event:35');
  });

  it('keeps cup-results off the global structure lock (FP-07 Codex P2)', () => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-sync',
      jobName: 'tournament-cup-results',
      eventId: 33,
    });
    expect(scopes).toEqual(['tournament-cup-results:event:33']);
    expect(scopes).not.toContain('tournament-structure:global');
  });

  it('makes setup rebuild scopes mutually exclusive with structure results (C4)', () => {
    const setupScopes = tournamentSetupRebuildScopes(789);
    for (const jobName of [
      'tournament-points-race',
      'tournament-battle-race',
      'tournament-knockout',
    ]) {
      const resultsScopes = resolveMutationScopes({
        queueName: 'tournament-sync',
        jobName,
        eventId: 33,
      });
      const overlap = setupScopes.filter((scope) => resultsScopes.includes(scope));
      expect(overlap).toContain('tournament-structure:global');
    }
  });

  it('serializes materialized-views refresh with structure writers, not cup (FP-07)', () => {
    const refreshScopes = resolveMutationScopes({
      queueName: 'tournament-sync',
      jobName: 'tournament-materialized-views-refresh',
      eventId: 33,
    });
    expect(refreshScopes).toContain('tournament-structure:global');

    for (const jobName of [
      'tournament-points-race',
      'tournament-battle-race',
      'tournament-knockout',
    ]) {
      const other = resolveMutationScopes({
        queueName: 'tournament-sync',
        jobName,
        eventId: 33,
      });
      expect(refreshScopes.filter((scope) => other.includes(scope))).toContain(
        'tournament-structure:global',
      );
    }

    expect(
      refreshScopes.filter((scope) => tournamentSetupRebuildScopes(789).includes(scope)),
    ).toContain('tournament-structure:global');

    const cupScopes = resolveMutationScopes({
      queueName: 'tournament-sync',
      jobName: 'tournament-cup-results',
      eventId: 33,
    });
    expect(refreshScopes.filter((scope) => cupScopes.includes(scope))).toEqual([]);
  });
});
