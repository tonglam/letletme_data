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
    expect(scopes).toContain('entry-event:event:33');
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
});
