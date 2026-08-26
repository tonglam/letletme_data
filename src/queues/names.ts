export const dataSyncQueueName = 'data-sync';
export const fplCriticalSyncQueueName = 'fpl-critical-sync';
export const entrySyncQueueName = 'entry-sync';
export const leagueSyncQueueName = 'league-sync';
export const liveDataQueueName = 'live-data';
export const managerLiveQueueName = 'manager-live';
export const tournamentSyncQueueName = 'tournament-sync';
export const tournamentSetupQueueName = 'tournament-setup';
export const tournamentRepairQueueName = 'tournament-repair';
export const understatPlayerQueueName = 'understat-player-sync';
export const understatTeamQueueName = 'understat-team-sync';
export const maintenanceQueueName = 'maintenance';

export const contentHttpAcquisitionQueueName = 'content-http-acquisition';
export const contentMediaTranscriptQueueName = 'content-media-transcript';
export const contentXScanQueueName = 'content-x-scan';

export const queueNames = [
  dataSyncQueueName,
  fplCriticalSyncQueueName,
  entrySyncQueueName,
  leagueSyncQueueName,
  liveDataQueueName,
  managerLiveQueueName,
  tournamentSyncQueueName,
  tournamentSetupQueueName,
  understatPlayerQueueName,
  understatTeamQueueName,
  tournamentRepairQueueName,
  maintenanceQueueName,
] as const;

export const contentQueueNames = [
  contentHttpAcquisitionQueueName,
  contentMediaTranscriptQueueName,
  contentXScanQueueName,
] as const;

export const allQueueNames = [...queueNames, ...contentQueueNames] as const;

export type QueueName = (typeof queueNames)[number];
