import { describe, expect, it } from 'bun:test';

import {
  resolveMutationScopes,
  tournamentSetupBackfillEventScopes,
  tournamentSetupLifecycleScope,
  tournamentSetupRebuildScopes,
} from '../../src/domain/mutation-scope';

describe('resolveMutationScopes', () => {
  it('maps the canonical live queue name', () => {
    const scopes = resolveMutationScopes({
      queueName: 'live-data',
      jobName: 'live-snapshot',
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
  ])('does not recognize unknown live job %s', (jobName) => {
    expect(resolveMutationScopes({ queueName: 'live-data', jobName, eventId: 33 })).toEqual([]);
  });

  it('maps only the canonical snapshot jobs to complete publication scopes', () => {
    const snapshotScopes = resolveMutationScopes({
      queueName: 'live-data',
      jobName: 'live-snapshot',
      eventId: 33,
    });
    const fixtureScopes = resolveMutationScopes({
      queueName: 'data-sync',
      jobName: 'core-snapshot',
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

  it('keeps partial price updates inside the canonical player publication scope', () => {
    const fullSync = resolveMutationScopes({ queueName: 'data-sync', jobName: 'core-snapshot' });
    const priceSync = resolveMutationScopes({
      queueName: 'data-sync',
      jobName: 'player-prices',
    });

    expect(fullSync).toContain('data-core:players');
    expect(priceSync).toEqual(['data-core:players']);
  });

  it('serializes player stats publication with the canonical player roster', () => {
    expect(
      resolveMutationScopes({
        queueName: 'data-sync',
        jobName: 'player-stats',
      }),
    ).toEqual(['data-core:players']);
  });

  it('serializes price-change publication with the canonical player roster', () => {
    expect(
      resolveMutationScopes({
        queueName: 'data-sync',
        jobName: 'price-change-predictions',
      }),
    ).toEqual(['data-core:players', 'data-price-change:publication']);
  });

  it('adds event-scoped conflict groups for league event results', () => {
    const scopes = resolveMutationScopes({
      queueName: 'league-sync',
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
      queueName: 'tournament-setup',
      jobName: 'tournament-setup',
      tournamentId: 789,
    });
    expect(scopes).toEqual([]);
  });

  it('does not reintroduce the global entry-info lock', () => {
    expect(
      resolveMutationScopes({
        queueName: 'entry-sync',
        jobName: 'entry-info',
      }),
    ).toEqual([]);
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
      queueName: 'tournament-sync',
      jobName: 'tournament-selection-stats',
      eventId: 35,
    });
    expect(scopes).toEqual(['tournament-event-mutations:event:35']);
  });

  it.each([
    'tournament-points-race',
    'tournament-battle-race',
    'tournament-knockout',
    'tournament-official-h2h',
  ])('gives %s the shared global structure scope (FP-07)', (jobName) => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-sync',
      jobName,
      eventId: 33,
    });
    expect(scopes).toContain('tournament-structure:global');
    expect(scopes).toContain('tournament-structure:event:33');
  });

  it('narrows tournament event results to per-table entry scopes (FP-14h)', () => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-sync',
      jobName: 'tournament-event-results',
      eventId: 35,
    });
    expect(scopes).toContain('data-core:events');
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
      'tournament-official-h2h',
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
    expect(refreshScopes).toContain('data-core:events');

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

  it('protects Understat review commands and bridge writers with durable scopes', () => {
    expect(
      resolveMutationScopes({
        queueName: 'understat-mappings',
        jobName: 'understat-mappings-reconcile',
      }),
    ).toEqual(['understat:reference:all']);
    expect(
      resolveMutationScopes({
        queueName: 'understat-player-sync',
        jobName: 'understat-player-detail',
      }),
    ).toEqual(['understat:reference:all']);
    expect(resolveMutationScopes({ queueName: 'bridge', jobName: 'entity-link' })).toEqual([
      'bridge:all',
    ]);
  });
});
