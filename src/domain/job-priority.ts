export const MUTATION_PRIORITY_ORDER = ['p0', 'p1', 'p2', 'p3'] as const;

export type MutationPriorityTier = (typeof MUTATION_PRIORITY_ORDER)[number];

export const MUTATION_PRIORITY_TABLES = {
  p0: [
    'tournament_entries',
    'tournament_battle_group_results',
    'tournament_points_race_results',
    'tournament_groups',
    'tournament_knockouts',
    'tournament_knockout_results',
  ],
  p1: ['entry_infos', 'entry_history_infos', 'entry_league_infos'],
  p2: [
    'entry_event_results',
    'entry_event_picks',
    'entry_event_transfers',
    'tournament_selection_stats',
  ],
  p3: ['league_event_results'],
} as const;

export type DataSyncPriorityJobName =
  | 'events'
  | 'fixtures'
  | 'fixtures-all-gameweeks'
  | 'teams'
  | 'players'
  | 'player-stats'
  | 'phases'
  | 'player-values';

export type EntrySyncPriorityJobName =
  | 'entry-info'
  | 'entry-picks'
  | 'entry-transfers'
  | 'entry-results';

export type LiveDataPriorityJobName =
  | 'event-lives-cache'
  | 'event-lives-db'
  | 'event-live-summary'
  | 'event-live-explain'
  | 'live-fixture-cache'
  | 'live-bonus-cache'
  | 'event-overall-result'
  | 'live-scores';

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
  | 'tournament-info';

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
    case 'event-lives-cache':
    case 'event-lives-db':
    case 'event-live-explain':
    case 'live-fixture-cache':
    case 'live-bonus-cache':
    case 'live-scores':
      return 'p0';
    case 'event-live-summary':
    case 'event-overall-result':
      return 'p3';
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
