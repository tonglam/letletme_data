import { describe, expect, it } from 'bun:test';

import { resolveMutationScopes } from '../../src/domain/mutation-scope';

describe('resolveMutationScopes', () => {
  it('normalizes tiered queue names', () => {
    const scopes = resolveMutationScopes({
      queueName: 'live-data-p0',
      jobName: 'event-lives-db',
      eventId: 33,
    });
    expect(scopes).toEqual(['event-live:event:33']);
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

  it('locks tournament setup by tournament id', () => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-setup-p0',
      jobName: 'tournament-setup',
      tournamentId: 789,
    });
    expect(scopes).toContain('tournament-structure:tournament:789');
    expect(scopes).toContain('entry-core:all');
  });

  it('keeps tournament selection stats serialized with tournament event mutations', () => {
    const scopes = resolveMutationScopes({
      queueName: 'tournament-sync-p2',
      jobName: 'tournament-selection-stats',
      eventId: 35,
    });
    expect(scopes).toContain('entry-event-picks:event:35');
    expect(scopes).toContain('entry-event-transfers:event:35');
    expect(scopes).toContain('entry-event-results:event:35');
    expect(scopes).toContain('tournament-event-mutations:event:35');
  });

  it('scopes entry-sync jobs per table so different tables do not serialize', () => {
    const picks = resolveMutationScopes({
      queueName: 'entry-sync-p2',
      jobName: 'entry-picks',
      eventId: 33,
    });
    const transfers = resolveMutationScopes({
      queueName: 'entry-sync-p2',
      jobName: 'entry-transfers',
      eventId: 33,
    });
    const results = resolveMutationScopes({
      queueName: 'entry-sync-p2',
      jobName: 'entry-results',
      eventId: 33,
    });

    expect(picks).toEqual(['entry-event-picks:event:33']);
    expect(transfers).toEqual(['entry-event-transfers:event:33']);
    expect(results).toEqual(['entry-event-results:event:33']);

    // No shared scope between different tables — a slow picks run must not block results
    expect(picks.filter((s) => transfers.includes(s) || results.includes(s))).toEqual([]);
  });

  it('shares the per-table scope across entry, league, and tournament writers', () => {
    const entryPicks = resolveMutationScopes({
      queueName: 'entry-sync-p2',
      jobName: 'entry-picks',
      eventId: 33,
    });
    const leaguePicks = resolveMutationScopes({
      queueName: 'league-sync-p3',
      jobName: 'league-event-picks',
      eventId: 33,
      tournamentId: 1001,
    });
    const tournamentPicks = resolveMutationScopes({
      queueName: 'tournament-sync-p2',
      jobName: 'tournament-event-picks',
      eventId: 33,
    });
    const tournamentTransfersPost = resolveMutationScopes({
      queueName: 'tournament-sync-p2',
      jobName: 'tournament-transfers-post',
      eventId: 33,
    });
    const tournamentResults = resolveMutationScopes({
      queueName: 'tournament-sync-p2',
      jobName: 'tournament-event-results',
      eventId: 33,
    });

    // Same-table writers across domains share exactly one table scope
    expect(leaguePicks).toContain('entry-event-picks:event:33');
    expect(tournamentPicks).toContain('entry-event-picks:event:33');
    expect(entryPicks).toEqual(['entry-event-picks:event:33']);
    expect(tournamentTransfersPost).toContain('entry-event-transfers:event:33');
    expect(tournamentTransfersPost).not.toContain('entry-event-picks:event:33');
    expect(tournamentResults).toContain('entry-event-results:event:33');
    expect(tournamentResults).not.toContain('entry-event-picks:event:33');
  });
});
