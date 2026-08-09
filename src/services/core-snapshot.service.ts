import { randomUUID } from 'node:crypto';

import {
  clearStaleSeasonCache,
  isNewerSeason,
  readStoredActiveCacheSeason,
} from '../cache/cache-season';
import { fplClient, type FPLBootstrapResponse } from '../clients/fpl';
import {
  CORE_SNAPSHOT_MUTATION_SCOPES,
  prepareCoreSnapshot,
  type CoreSnapshot,
} from '../domain/core-snapshot';
import { allocateCoreSnapshotRevision } from '../repositories/core-snapshot-authority';
import {
  commitCoreSnapshotPublication,
  readCoreSnapshotOrderingTimestamp,
  recoverPendingCoreSnapshotPublication,
  type CoreSnapshotPublicationContext,
} from './core-snapshot-publication.service';

import type { RawFPLFixture } from '../types';

export type CoreSnapshotMilestone = 'fetched' | 'validated' | 'locked' | 'persisted' | 'published';

export interface CoreSnapshotSyncResult {
  outcome: 'ready' | 'noop';
  season: string;
  events: number;
  teams: number;
  players: number;
  phases: number;
  fixtures: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}

export interface CoreSnapshotDependencies {
  getBootstrap: () => Promise<FPLBootstrapResponse>;
  getFixtures: () => Promise<RawFPLFixture[]>;
  getActiveSeason: () => Promise<string | null>;
  readOrderingTimestamp: () => Promise<Date>;
  reserveRevision: () => Promise<number>;
  createPublicationId: () => string;
  recoverPending: () => Promise<unknown>;
  recoverPendingWithoutLock?: () => Promise<unknown>;
  commit: (
    snapshot: CoreSnapshot,
    context: CoreSnapshotPublicationContext,
  ) => Promise<{ status: 'committed' | 'stale' }>;
  cleanup: (season: string) => Promise<void>;
  withPersistenceLock: <T>(operation: () => Promise<T>) => Promise<T>;
  onMilestone?: (milestone: CoreSnapshotMilestone) => void;
}

const defaultDependencies: CoreSnapshotDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  getFixtures: () => fplClient.getFixtures(),
  getActiveSeason: readStoredActiveCacheSeason,
  readOrderingTimestamp: readCoreSnapshotOrderingTimestamp,
  reserveRevision: allocateCoreSnapshotRevision,
  createPublicationId: randomUUID,
  recoverPending: async () => {
    const { withMutationConflictGuard } = await import('../utils/mutation-lock');
    return withMutationConflictGuard(
      {
        queueName: 'data-sync',
        jobName: 'core-snapshot-recovery',
        scopes: [...CORE_SNAPSHOT_MUTATION_SCOPES],
      },
      recoverPendingCoreSnapshotPublication,
    );
  },
  recoverPendingWithoutLock: recoverPendingCoreSnapshotPublication,
  commit: commitCoreSnapshotPublication,
  cleanup: (season) => clearStaleSeasonCache(season),
  withPersistenceLock: async (operation) => {
    const { withMutationConflictGuard } = await import('../utils/mutation-lock');
    return withMutationConflictGuard(
      {
        queueName: 'data-sync',
        jobName: 'core-snapshot',
        scopes: [...CORE_SNAPSHOT_MUTATION_SCOPES],
      },
      operation,
    );
  },
};

function workUnits(snapshot: CoreSnapshot): number {
  return (
    snapshot.events.length +
    snapshot.teams.length +
    snapshot.players.length +
    snapshot.phases.length +
    snapshot.fixtures.length
  );
}

function result(snapshot: CoreSnapshot, published: boolean): CoreSnapshotSyncResult {
  const requiredUnits = workUnits(snapshot);
  return {
    outcome: published ? 'ready' : 'noop',
    season: snapshot.season,
    events: snapshot.events.length,
    teams: snapshot.teams.length,
    players: snapshot.players.length,
    phases: snapshot.phases.length,
    fixtures: snapshot.fixtures.length,
    requiredUnits,
    reusedUnits: published ? 0 : requiredUnits,
    succeededUnits: published ? requiredUnits : 0,
    failedUnits: 0,
  };
}

export async function syncCoreSnapshot(
  dependencies: CoreSnapshotDependencies = defaultDependencies,
  options: { mutationScopesAlreadyHeld?: boolean } = {},
): Promise<CoreSnapshotSyncResult> {
  // Season archival holds the canonical core scopes across the final refresh,
  // so the nested recovery/persistence guards must reuse that caller-owned
  // lock instead of trying to acquire the same Redis keys again.
  const mutationScopesAlreadyHeld = options.mutationScopesAlreadyHeld === true;
  const recoverPending = mutationScopesAlreadyHeld
    ? (dependencies.recoverPendingWithoutLock ?? dependencies.recoverPending)
    : dependencies.recoverPending;
  await recoverPending();
  const revision = await dependencies.reserveRevision();
  const publicationId = dependencies.createPublicationId();
  const sourceCheckedAt = await dependencies.readOrderingTimestamp();
  const [bootstrap, fixtures] = await Promise.all([
    dependencies.getBootstrap(),
    dependencies.getFixtures(),
  ]);
  dependencies.onMilestone?.('fetched');

  const snapshot = prepareCoreSnapshot(bootstrap, fixtures);
  dependencies.onMilestone?.('validated');

  const persist = mutationScopesAlreadyHeld
    ? (operation: () => Promise<CoreSnapshotSyncResult>) => operation()
    : dependencies.withPersistenceLock;

  return persist(async () => {
    dependencies.onMilestone?.('locked');
    const activeSeason = await dependencies.getActiveSeason();
    if (activeSeason && isNewerSeason(activeSeason, snapshot.season)) {
      return result(snapshot, false);
    }

    const publication = await dependencies.commit(snapshot, {
      revision,
      publicationId,
      previousActiveSeason: activeSeason,
      sourceCheckedAt,
    });
    if (publication.status === 'stale') {
      return result(snapshot, false);
    }
    dependencies.onMilestone?.('persisted');
    // The publication can release its lock before a newer season acquires the
    // authority. Recheck before deleting any season-prefixed cache keys.
    const cleanupSeason = await dependencies.getActiveSeason();
    if (cleanupSeason === snapshot.season) {
      await dependencies.cleanup(snapshot.season);
    }
    dependencies.onMilestone?.('published');
    return result(snapshot, true);
  });
}
