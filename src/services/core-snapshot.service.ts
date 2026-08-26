import { randomUUID } from 'node:crypto';

import { fplClient, type FPLBootstrapResponse } from '../clients/fpl';
import {
  CORE_SNAPSHOT_MUTATION_SCOPES,
  prepareCoreSnapshot,
  type CoreSnapshot,
} from '../domain/core-snapshot';
import {
  prepareCoreSnapshotCache,
  selectCurrentEventIdByDeadline,
} from '../cache/core-snapshot-cache';
import { seasonRepository } from '../repositories/seasons';
import type { FplSeasonRef } from '../domain/fpl-season';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { DatabaseError } from '../utils/errors';
import { withMutationScopes } from '../utils/mutation-scopes';
import {
  persistCoreSnapshotPublication,
  publishCoreSnapshotPublication,
  readCoreSnapshotOrderingTimestamp,
  recoverPendingCoreSnapshotPublication,
} from './core-snapshot-publication.service';
import { CORE_SNAPSHOT_STALE_SOURCE_CODE } from './core-snapshot-persistence.service';

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
  /**
   * Correlate the durable publication run with the scheduler/Bull execution
   * that owns it.  The scheduler stores this value on the obligation so the
   * freshness ledger can join the publication back to the exact window.
   */
  readonly sourceRunId?: string;
  /** Exact freshness window being repaired, carried into the publication manifest. */
  readonly freshnessWindowId?: number;
  /**
   * Optional exact bootstrap captured by a deadline-sensitive price watcher.
   * Core still fetches fixtures through its normal dependency, but the player,
   * team, event and phase rows come from the same provider response that
   * triggered the provisional price board.
   */
  readonly bootstrap?: FPLBootstrapResponse;
  /**
   * Preserve the provider capture time when a watcher replays an archived
   * bootstrap. A delayed repair must not look newer than an intervening Core
   * publication merely because the worker started later.
   */
  readonly sourceCheckedAt?: Date;
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
  const sourceRunId = options.sourceRunId ?? randomUUID();
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
  let validatedSnapshot: CoreSnapshot | null = null;
  try {
    const sourceCheckedAt = options.sourceCheckedAt
      ? new Date(options.sourceCheckedAt)
      : await dependencies.readOrderingTimestamp();
    if (!Number.isFinite(sourceCheckedAt.getTime())) {
      throw new Error('Core snapshot source capture timestamp is invalid');
    }
    const [bootstrap, fixtures] = await Promise.all([
      options.bootstrap ? Promise.resolve(options.bootstrap) : dependencies.getBootstrap(),
      dependencies.getFixtures(),
    ]);
    dependencies.onMilestone?.('fetched');

    const snapshot = prepareCoreSnapshot(bootstrap, fixtures);
    validatedSnapshot = snapshot;
    if (snapshot.season !== currentSeason.seasonCode) {
      throw new Error(
        `Upstream core season ${snapshot.season} does not match current database season ${currentSeason.seasonCode}`,
      );
    }
    dependencies.onMilestone?.('validated');
    const publicationId = randomUUID();
    preparedPublicationId = publicationId;
    const preparedAndPersisted = await withMutationScopes(
      {
        queueName: 'data-sync',
        jobName: 'core-snapshot',
        scopes: [...CORE_SNAPSHOT_MUTATION_SCOPES],
      },
      async () => {
        dependencies.onMilestone?.('locked');
        // Keep the staging publication, immutable DB item proof and canonical
        // FPL rows in one short PostgreSQL mutation transaction. Redis is
        // still delivered only after this transaction commits.
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
        const preparedCache = prepareCoreSnapshotCache(snapshot, {
          revision: prepared.revision,
          publicationId: prepared.publicationId,
          sourceCheckedAt,
          freshnessWindowId: options.freshnessWindowId,
        });
        const payloads: Record<string, unknown> = {
          events: snapshot.events,
          teams: snapshot.teams,
          players: snapshot.players,
          phases: snapshot.phases,
          fixtures: snapshot.fixtures,
          currentEventId: selectCurrentEventIdByDeadline(snapshot.events, sourceCheckedAt),
          selectionRules: snapshot.selectionRules ?? null,
        };
        await syncOperationsRepository.stagePublicationItems(
          prepared.publicationId,
          preparedCache.manifest.items.map((item) => ({
            name: item.name as
              | 'events'
              | 'teams'
              | 'players'
              | 'phases'
              | 'fixtures'
              | 'currentEventId'
              | 'selectionRules',
            payload: payloads[item.name],
            count: item.count,
            checksum: item.sha256,
          })),
        );
        const persisted = await persistCoreSnapshotPublication(snapshot, {
          revision: prepared.revision,
          publicationId: prepared.publicationId,
          sourceRunId,
          sourceCheckedAt,
          freshnessWindowId: options.freshnessWindowId,
        });
        return { prepared, persisted, preparedCache };
      },
    );
    persistenceCommitted = true;
    dependencies.onMilestone?.('persisted');
    const committed = await publishCoreSnapshotPublication(
      preparedAndPersisted.persisted,
      {
        revision: preparedAndPersisted.prepared.revision,
        publicationId: preparedAndPersisted.prepared.publicationId,
        sourceRunId,
        sourceCheckedAt,
        freshnessWindowId: options.freshnessWindowId,
      },
      preparedAndPersisted.preparedCache,
    );
    if (committed.status === 'stale') return result(snapshot, false);
    dependencies.onMilestone?.('published');
    return result(snapshot, true, {
      publicationId: preparedAndPersisted.prepared.publicationId,
      revision: preparedAndPersisted.prepared.revision,
    });
  } catch (error) {
    if (
      error instanceof DatabaseError &&
      error.code === CORE_SNAPSHOT_STALE_SOURCE_CODE &&
      preparedPublicationId
    ) {
      await syncOperationsRepository
        .skipPublication(preparedPublicationId, 'superseded-by-newer-core-source')
        .catch(() => undefined);
      if (!validatedSnapshot) throw error;
      return result(validatedSnapshot, false);
    }
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
