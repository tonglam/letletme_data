import { describe, expect, it } from 'bun:test';

import {
  getDataSyncJobPriority,
  getEntrySyncJobPriority,
  getLeagueSyncJobPriority,
  getLiveDataJobPriority,
  getTournamentSetupJobPriority,
  getTournamentSyncJobPriority,
  MUTATION_PRIORITY_ORDER,
  MUTATION_PRIORITY_TABLES,
} from '../../src/domain/job-priority';

describe('job priority mapping', () => {
  it('keeps canonical table order and groups', () => {
    expect(MUTATION_PRIORITY_ORDER).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(MUTATION_PRIORITY_TABLES.p0).toContain('competition.tournament_entries');
    expect(MUTATION_PRIORITY_TABLES.p3).toEqual(['competition.league_event_results']);
  });

  it('maps entry sync jobs to expected tiers', () => {
    expect(getEntrySyncJobPriority('entry-info')).toBe('p1');
    expect(getEntrySyncJobPriority('entry-picks')).toBe('p2');
    expect(getEntrySyncJobPriority('entry-transfers')).toBe('p2');
    expect(getEntrySyncJobPriority('entry-results')).toBe('p2');
  });

  it('keeps player price reconciliation in the primary data tier', () => {
    expect(getDataSyncJobPriority('player-prices')).toBe('p1');
  });

  it('maps tournament and league jobs to expected tiers', () => {
    expect(getTournamentSetupJobPriority('tournament-setup')).toBe('p0');
    expect(getTournamentSyncJobPriority('tournament-points-race')).toBe('p0');
    expect(getTournamentSyncJobPriority('tournament-battle-race')).toBe('p0');
    expect(getTournamentSyncJobPriority('tournament-roster-sync')).toBe('p0');
    expect(getTournamentSyncJobPriority('tournament-event-results')).toBe('p2');
    expect(getTournamentSyncJobPriority('tournament-selection-stats')).toBe('p2');
    expect(getTournamentSyncJobPriority('tournament-info')).toBe('p1');
    expect(getLeagueSyncJobPriority('league-event-results')).toBe('p3');
    expect(getLeagueSyncJobPriority('league-event-picks')).toBe('p2');
  });

  it('maps live data jobs to expected tiers', () => {
    expect(getLiveDataJobPriority('live-snapshot')).toBe('p0');
  });
});
