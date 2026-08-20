import { randomUUID } from 'node:crypto';

import { fplClient, type FPLBootstrapResponse } from '../clients/fpl';
import {
  CORE_SNAPSHOT_MUTATION_SCOPES,
  prepareCoreSnapshot,
  type CoreSnapshot,
} from '../domain/core-snapshot';
import { seasonRepository } from '../repositories/seasons';
import type { FplSeasonRef } from '../domain/fpl-season';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import {
  persistCoreSnapshotPublication,
  publishCoreSnapshotPublication,
  readCoreSnapshotOrderingTimestamp,
  recoverPendingCoreSnapshotPublication,
} from './core-snapshot-publication.service';

import type { RawFPLFixture } from '../types';

export type CoreSnapshotMilestone = 'fetched' | 'validated' | 'locked' | 'persisted' | 'published';

export interface CoreSnapshotSyncResult {
  readonly outcome: 'ready' | 'noop';
  readonly season: string;
  readonly events: number;
  readonly teams: number;
  readonly players: number;
  readonly phases: number;
  readonly fixtures: number;
  readonly requiredUnits: number;
  readonly reusedUnits: number;
  readonly succeededUnits: number;
  readonly failedUnits: number;
  readonly publicationId?: string;
  readonly revision?: number;
}

export interface CoreSnapshotDependencies {
  readonly getBootstrap: () => Promise<FPLBootstrapResponse>;
  readonly getFixtures: () => Promise<RawFPLFixture[]>;
  readonly readOrderingTimestamp: () => Promise<Date>;
  readonly recoverPending: (season: FplSeasonRef) => Promise<unknown>;
  readonly onMilestone?: (milestone: CoreSnapshotMilestone) => void;
}

export interface CoreSnapshotSyncOptions {
  readonly trigger?: 'cron' | 'manual' | 'queue' | 'event-transition';
  readonly dependencies?: CoreSnapshotDependencies;
}

const defaultDependencies: CoreSnapshotDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  getFixtures: () => fplClient.getFixtures(),
  readOrderingTimestamp: readCoreSnapshotOrderingTimestamp,
  recoverPending: (season) => recoverPendingCoreSnapshotPublication(season),
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

function result(
  snapshot: CoreSnapshot,
  published: boolean,
  publication?: { publicationId: string; revision: number },
): CoreSnapshotSyncResult {
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
    ...(publication ?? {}),
  };
}

export async function syncCoreSnapshot(
  currentSeason: FplSeasonRef,
  options: CoreSnapshotSyncOptions = {},
): Promise<CoreSnapshotSyncResult> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const trigger = options.trigger ?? 'queue';
  await dependencies.recoverPending(currentSeason);
  const authoritativeSeason = await seasonRepository.findCurrent();
  if (
    authoritativeSeason.seasonId !== currentSeason.seasonId ||
    authoritativeSeason.seasonCode !== currentSeason.seasonCode
  ) {
    throw new Error(`FPL season ${currentSeason.seasonCode} is no longer current`);
  }
  const sourceRunId = randomUUID();
  await syncOperationsRepository.startRun({
    runId: sourceRunId,
    provider: 'fpl',
    lane: 'core',
    scope: 'core-snapshot',
    season: currentSeason,
    mode: 'full',
    trigger,
  });

  let preparedPublicationId: string | null = null;
  let persistenceCommitted = false;
  try {
    const sourceCheckedAt = await dependencies.readOrderingTimestamp();
    const [bootstrap, fixtures] = await Promise.all([
      dependencies.getBootstrap(),
      dependencies.getFixtures(),
    ]);
    dependencies.onMilestone?.('fetched');

    const snapshot = prepareCoreSnapshot(bootstrap, fixtures);
    if (snapshot.season !== currentSeason.seasonCode) {
      throw new Error(
        `Upstream core season ${snapshot.season} does not match current database season ${currentSeason.seasonCode}`,
      );
    }
    dependencies.onMilestone?.('validated');
    const publicationId = randomUUID();
    preparedPublicationId = publicationId;
    const prepared = await syncOperationsRepository.preparePublication({
      publicationId,
      dataset: 'fpl:core',
      season: currentSeason,
      sourceRunId,
      manifest: {
        state: 'staging',
        sourceCheckedAt: sourceCheckedAt.toISOString(),
      },
    });

    const persisted = await withMutationConflictGuard(
      {
        queueName: 'data-sync',
        jobName: 'core-snapshot',
        scopes: [...CORE_SNAPSHOT_MUTATION_SCOPES],
      },
      async () => {
        dependencies.onMilestone?.('locked');
        return persistCoreSnapshotPublication(snapshot, {
          revision: prepared.revision,
          publicationId: prepared.publicationId,
          sourceRunId,
          sourceCheckedAt,
        });
      },
    );
    persistenceCommitted = true;
    dependencies.onMilestone?.('persisted');
    const committed = await publishCoreSnapshotPublication(persisted, {
      revision: prepared.revision,
      publicationId: prepared.publicationId,
      sourceRunId,
      sourceCheckedAt,
    });
    if (committed.status === 'stale') return result(snapshot, false);
    dependencies.onMilestone?.('published');
    return result(snapshot, true, {
      publicationId: prepared.publicationId,
      revision: prepared.revision,
    });
  } catch (error) {
    if (preparedPublicationId && !persistenceCommitted) {
      await syncOperationsRepository
        .failPublication(preparedPublicationId, error)
        .catch(() => undefined);
    } else if (!preparedPublicationId) {
      await syncOperationsRepository.failRun(sourceRunId, error).catch(() => undefined);
    }
    throw error;
  }
}
