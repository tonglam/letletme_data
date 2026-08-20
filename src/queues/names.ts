export const dataSyncQueueName = 'data-sync';
export const entrySyncQueueName = 'entry-sync';
export const leagueSyncQueueName = 'league-sync';
export const liveDataQueueName = 'live-data';
export const tournamentSyncQueueName = 'tournament-sync';
export const tournamentSetupQueueName = 'tournament-setup';
export const tournamentRepairQueueName = 'tournament-repair';
export const understatPlayerQueueName = 'understat-player-sync';
export const understatTeamQueueName = 'understat-team-sync';

export const queueNames = [
  dataSyncQueueName,
  entrySyncQueueName,
  leagueSyncQueueName,
  liveDataQueueName,
  tournamentSyncQueueName,
  tournamentSetupQueueName,
  understatPlayerQueueName,
  understatTeamQueueName,
  tournamentRepairQueueName,
] as const;

export type QueueName = (typeof queueNames)[number];
