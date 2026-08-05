import { syncCoreSnapshot, type CoreSnapshotSyncResult } from './core-snapshot.service';

export type PlayersSyncDependencies = {
  syncCore: () => Promise<CoreSnapshotSyncResult>;
};

/**
 * Player identity is part of the coherent non-Live core snapshot. Keeping this
 * compatibility entry point mapped to that publisher prevents a legacy player
 * refresh from racing or partially overwriting events, teams, phases, or
 * fixtures fetched from the same FPL bootstrap.
 */
export function createPlayersSync(dependencies: PlayersSyncDependencies) {
  return async function syncPlayers(): Promise<{ count: number; errors: number }> {
    const result = await dependencies.syncCore();
    return { count: result.players, errors: result.failedUnits };
  };
}

export const syncPlayers = createPlayersSync({ syncCore: syncCoreSnapshot });
