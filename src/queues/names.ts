export const dataSyncQueueName = 'data-sync';
export const fplCriticalSyncQueueName = 'fpl-critical-sync';
export const fplPriceWatchQueueName = 'fpl-price-watch';
export const entrySyncQueueName = 'entry-sync';
export const leagueSyncQueueName = 'league-sync';
export const liveDataQueueName = 'live-data';
export const tournamentSyncQueueName = 'tournament-sync';
export const tournamentSetupQueueName = 'tournament-setup';
export const tournamentRepairQueueName = 'tournament-repair';
export const understatPlayerQueueName = 'understat-player-sync';
export const understatTeamQueueName = 'understat-team-sync';
export const maintenanceQueueName = 'maintenance';
export const livePicksQueueName = 'live-picks';
export const officialH2hLiveQueueName = 'official-h2h-live';
export const myFplOrchestrationQueueName = 'my-fpl-orchestration';
export const publicationOutboxQueueName = 'publication-outbox';
export const entryOnboardingQueueName = 'entry-onboarding';
export const dataRepairQueueName = 'data-repair';
export const housekeepingQueueName = 'housekeeping';
export const dataGovernanceQueueName = 'data-governance';

export const contentHttpAcquisitionQueueName = 'content-http-acquisition';
export const contentMediaTranscriptQueueName = 'content-media-transcript';
export const contentXScanQueueName = 'content-x-scan';

export const queueNames = [
  dataSyncQueueName,
  fplCriticalSyncQueueName,
  fplPriceWatchQueueName,
  entrySyncQueueName,
  leagueSyncQueueName,
  liveDataQueueName,
  tournamentSyncQueueName,
  tournamentSetupQueueName,
  understatPlayerQueueName,
  understatTeamQueueName,
  tournamentRepairQueueName,
  maintenanceQueueName,
  livePicksQueueName,
  officialH2hLiveQueueName,
  myFplOrchestrationQueueName,
  publicationOutboxQueueName,
  entryOnboardingQueueName,
  dataRepairQueueName,
  housekeepingQueueName,
  dataGovernanceQueueName,
] as const;

export const contentQueueNames = [
  contentHttpAcquisitionQueueName,
  contentMediaTranscriptQueueName,
  contentXScanQueueName,
] as const;

export const allQueueNames = [...queueNames, ...contentQueueNames] as const;

export type QueueName = (typeof queueNames)[number];
