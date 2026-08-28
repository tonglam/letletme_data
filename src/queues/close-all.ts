import { closeDataGovernanceQueue } from './data-governance.queue';
import { closeDataSyncQueue } from './data-sync.queue';
import { closeEntrySyncQueue } from './entry-sync.queue';
import { closeFplCriticalSyncQueue } from './fpl-critical-sync.queue';
import { closeFplPriceWatchQueue } from './fpl-price-watch.queue';
import { closeLeagueSyncQueue } from './league-sync.queue';
import { closeLiveDataQueue } from './live-data.queue';
import { closeLivePicksQueue } from './live-picks.queue';
import { closeMaintenanceQueue } from './maintenance.queue';
import { closeManagerLiveQueue } from './manager-live.queue';
import { closeOfficialH2HLiveQueue } from './official-h2h-live.queue';
import { closeTournamentRepairQueue } from './tournament-repair.queue';
import { closeTournamentSetupQueue } from './tournament-setup.queue';
import { closeTournamentSyncQueue } from './tournament-sync.queue';
import { closeUnderstatPlayerQueue } from './understat-player.queue';
import { closeUnderstatTeamQueue } from './understat-team.queue';

/** Close every producer queue owned by the Data process. */
export async function closeAllProducerQueues(): Promise<void> {
  const settled = await Promise.allSettled([
    closeDataGovernanceQueue(),
    closeDataSyncQueue(),
    closeEntrySyncQueue(),
    closeFplCriticalSyncQueue(),
    closeFplPriceWatchQueue(),
    closeLeagueSyncQueue(),
    closeLiveDataQueue(),
    closeLivePicksQueue(),
    closeMaintenanceQueue(),
    closeManagerLiveQueue(),
    closeOfficialH2HLiveQueue(),
    closeTournamentRepairQueue(),
    closeTournamentSetupQueue(),
    closeTournamentSyncQueue(),
    closeUnderstatPlayerQueue(),
    closeUnderstatTeamQueue(),
  ]);
  const failures = settled
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} producer queue(s) failed to close`);
  }
}
