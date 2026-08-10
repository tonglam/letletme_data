export const MUTATION_PRIORITY_ORDER = ['p0', 'p1', 'p2', 'p3'] as const;

export type MutationPriorityTier = (typeof MUTATION_PRIORITY_ORDER)[number];

export const MUTATION_PRIORITY_TABLES = {
  p0: [
    'competition.tournament_entries',
    'competition.tournament_battle_group_results',
    'competition.tournament_points_group_results',
    'competition.tournament_groups',
    'competition.tournament_knockouts',
    'competition.tournament_knockout_results',
  ],
  p1: [
    'competition.entries',
    'competition.entry_season_histories',
    'competition.entry_league_memberships',
  ],
  p2: [
    'competition.entry_event_results',
    'competition.entry_event_picks',
    'competition.entry_event_transfers',
    'reporting.tournament_selection_stats',
  ],
  p3: ['competition.league_event_results'],
} as const;

export type DataSyncPriorityJobName =
  | 'core-snapshot'
  | 'player-prices'
  | 'player-stats'
  | 'player-values';

export type EntrySyncPriorityJobName =
  | 'entry-info'
  | 'entry-picks'
  | 'entry-transfers'
  | 'entry-results';

export type LiveDataPriorityJobName = 'live-snapshot';

export type LeagueSyncPriorityJobName = 'league-event-picks' | 'league-event-results';

export type TournamentSyncPriorityJobName =
  | 'tournament-event-results'
  | 'tournament-points-race'
  | 'tournament-battle-race'
  | 'tournament-knockout'
  | 'tournament-transfers-post'
  | 'tournament-cup-results'
  | 'tournament-selection-stats'
  | 'tournament-materialized-views-refresh'
  | 'tournament-event-picks'
  | 'tournament-transfers-pre'
  | 'tournament-info'
  | 'tournament-roster-sync';

export type TournamentSetupPriorityJobName = 'tournament-setup';

export function getDataSyncJobPriority(_: DataSyncPriorityJobName): MutationPriorityTier {
  return 'p1';
}

export function getEntrySyncJobPriority(jobName: EntrySyncPriorityJobName): MutationPriorityTier {
  switch (jobName) {
    case 'entry-info':
      return 'p1';
    case 'entry-picks':
    case 'entry-transfers':
    case 'entry-results':
      return 'p2';
  }
}

export function getLiveDataJobPriority(jobName: LiveDataPriorityJobName): MutationPriorityTier {
  switch (jobName) {
    case 'live-snapshot':
      return 'p0';
  }
}

export function getLeagueSyncJobPriority(jobName: LeagueSyncPriorityJobName): MutationPriorityTier {
  switch (jobName) {
    case 'league-event-results':
      return 'p3';
    case 'league-event-picks':
      return 'p2';
  }
}

export function getTournamentSyncJobPriority(
  jobName: TournamentSyncPriorityJobName,
): MutationPriorityTier {
  switch (jobName) {
    case 'tournament-points-race':
    case 'tournament-battle-race':
    case 'tournament-knockout':
    case 'tournament-cup-results':
    case 'tournament-roster-sync':
      return 'p0';
    case 'tournament-event-results':
    case 'tournament-event-picks':
    case 'tournament-transfers-pre':
    case 'tournament-transfers-post':
    case 'tournament-selection-stats':
      return 'p2';
    case 'tournament-info':
      return 'p1';
    case 'tournament-materialized-views-refresh':
      return 'p3';
  }
}

export function getTournamentSetupJobPriority(
  _: TournamentSetupPriorityJobName,
): MutationPriorityTier {
  return 'p0';
}
