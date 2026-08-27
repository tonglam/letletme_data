import {
  publishCoreSnapshotCache,
  readCoreSnapshotCache,
  selectCurrentEventIdByDeadline,
  type CoreSnapshotCachePublication,
} from '../cache/core-snapshot-cache';
import { stageDataPublication } from '../cache/data-publication';
import { dispatchDataPublicationOutbox } from './data-publication-delivery.service';
import { randomUUID } from 'node:crypto';
import { explicitSeasonRef, type FplSeasonRef } from '../domain/fpl-season';
import { seasonRepository } from '../repositories/seasons';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import {
  persistCoreSnapshot,
  readCoreSnapshotOrderingTimestamp,
  type CoreSnapshotPersistenceResult,
} from './core-snapshot-persistence.service';
import { refreshPlayerSeasonSummaries } from './player-season-summaries.service';

import type { CoreSnapshot } from '../domain/core-snapshot';
import type { PreparedCoreSnapshotCachePublication } from '../cache/core-snapshot-cache';

export interface CoreSnapshotPublicationContext {
  readonly revision: number;
  readonly publicationId: string;
  readonly sourceRunId: string;
  readonly sourceCheckedAt: Date;
  readonly freshnessWindowId?: number;
}

export interface CoreSnapshotCommitResult {
  readonly status: 'committed' | 'stale';
  readonly persistence: CoreSnapshotPersistenceResult;
  readonly publication: CoreSnapshotCachePublication;
}

export type CoreSnapshotPersistedResult = Readonly<{
  snapshot: CoreSnapshot;
  persistence: CoreSnapshotPersistenceResult;
}>;

export { readCoreSnapshotOrderingTimestamp };

/**
 * Persist only canonical PostgreSQL facts and reporting projections. Cache and
 * ops-publication handoffs intentionally happen in a separate phase after the
 * caller's mutation transaction has committed.
 */
export async function persistCoreSnapshotPublication(
  snapshot: CoreSnapshot,
  context: CoreSnapshotPublicationContext,
): Promise<CoreSnapshotPersistedResult> {
  const season = explicitSeasonRef(snapshot.season);
  const persisted = await persistCoreSnapshot(snapshot, context.sourceCheckedAt);
  try {
    // Core publications can change the roster or player positions before any
    // live gameweek write occurs, so refresh the reporting read model here as
    // well as on the live-write path.
    await refreshPlayerSeasonSummaries(season);
  } catch (error) {
    logError('Player season summary refresh failed after core publication', error, {
      season: season.seasonCode,
      revision: context.revision,
    });
  }
  return persisted;
}

/** Publish a previously committed canonical snapshot to Redis and ops. */
export async function publishCoreSnapshotPublication(
  persisted: CoreSnapshotPersistedResult,
  context: CoreSnapshotPublicationContext,
  preparedCache?: PreparedCoreSnapshotCachePublication,
): Promise<CoreSnapshotCommitResult> {
  const season = explicitSeasonRef(persisted.snapshot.season);
  try {
    const publication = preparedCache
      ? await (async () => {
          await stageDataPublication(preparedCache);
          const current = await seasonRepository.findCurrent();
          return {
            published:
              current.seasonId === season.seasonId && current.seasonCode === season.seasonCode,
            reason: 'published' as const,
            manifest: preparedCache.manifest,
            previousManifest: null,
          };
        })()
      : await publishCoreSnapshotCache(persisted.snapshot, {
          revision: context.revision,
          publicationId: context.publicationId,
          sourceCheckedAt: context.sourceCheckedAt,
          freshnessWindowId: context.freshnessWindowId,
          activate: false,
          afterStage: async (manifest) => {
            const payloads: Record<string, unknown> = {
              events: persisted.snapshot.events,
              teams: persisted.snapshot.teams,
              players: persisted.snapshot.players,
              phases: persisted.snapshot.phases,
              fixtures: persisted.snapshot.fixtures,
              currentEventId: selectCurrentEventIdByDeadline(
                persisted.snapshot.events,
                context.sourceCheckedAt,
              ),
              selectionRules: persisted.snapshot.selectionRules ?? null,
            };
            await syncOperationsRepository.stagePublicationItems(
              context.publicationId,
              manifest.items.map((item) => ({
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
          },
          beforeActivate: async () => {
            const current = await seasonRepository.findCurrent();
            return current.seasonId === season.seasonId && current.seasonCode === season.seasonCode;
          },
        });
    if (!publication.published) {
      await syncOperationsRepository.skipPublication(
        context.publicationId,
        'A newer core publication already owns the cache scope',
      );
      await syncOperationsRepository.finishRun(context.sourceRunId, {
        status: 'skipped',
        completedItems: 0,
        skippedItems:
          persisted.persistence.events +
          persisted.persistence.teams +
          persisted.persistence.players +
          persisted.persistence.phases +
          persisted.persistence.fixtures,
        dataChanged: false,
      });
      return { status: 'stale', persistence: persisted.persistence, publication };
    }
    await withMutationScopes(
      {
        queueName: 'fpl-critical-sync',
        jobName: 'core-snapshot',
        scopes: ['data-core:publication'],
      },
      () =>
        syncOperationsRepository.activatePublication({
          publicationId: context.publicationId,
          dataset: 'fpl:core',
          season,
          sourceRunId: context.sourceRunId,
          manifest: publication.manifest,
          outbox: { outboxId: randomUUID() },
        }),
    );
    const delivered = await dispatchDataPublicationOutbox({
      limit: 1,
      publicationId: context.publicationId,
    });
    if (delivered.delivered !== 1) {
      throw new Error(
        `Core publication ${context.publicationId} is canonical but Redis delivery is pending`,
      );
    }
    return { status: 'committed', persistence: persisted.persistence, publication };
  } catch (error) {
    // Canonical PostgreSQL persistence already committed before this phase.
    // Leave the ops row staging so recovery can retry or reconcile the cache
    // handoff instead of reporting a durable snapshot as failed.
    throw error;
  }
}

/** Backward-compatible combined helper for callers that do not need a
 * mutation-scope boundary around the canonical and cache phases separately. */
export async function commitCoreSnapshotPublication(
  snapshot: CoreSnapshot,
  context: CoreSnapshotPublicationContext,
): Promise<CoreSnapshotCommitResult> {
  const persisted = await persistCoreSnapshotPublication(snapshot, context);
  return publishCoreSnapshotPublication(persisted, context);
}

export async function recoverPendingCoreSnapshotPublication(
  season: FplSeasonRef,
): Promise<'none' | 'activated'> {
  const cached = await readCoreSnapshotCache(season.seasonCode);
  if (!cached) return 'none';

  const active = await syncOperationsRepository.findActivePublication('fpl:core', season);
  if (active?.publicationId === cached.manifest.publicationId) return 'none';

  const pending = await syncOperationsRepository.findPublicationById(cached.manifest.publicationId);
  if (
    !pending ||
    pending.status !== 'staging' ||
    pending.dataset !== 'fpl:core' ||
    pending.seasonId !== season.seasonId ||
    pending.eventId !== null ||
    pending.revision !== cached.manifest.revision ||
    !pending.sourceRunId
  ) {
    // A Redis-only/legacy pointer is a ghost, not authority.  Leave it in
    // place for the compare-if-current reconciler; a fresh core job must first
    // commit canonical facts and a complete DB proof.
    logError(
      'Active core cache manifest has no recoverable DB publication; refusing promotion',
      new DatabaseError(
        'Active core cache manifest has no recoverable ops publication',
        'CORE_PUBLICATION_RECOVERY_CONTRACT_MISMATCH',
      ),
      { season: season.seasonCode, publicationId: cached.manifest.publicationId },
    );
    return 'none';
  }
  const sourceRunId = pending.sourceRunId;

  await withMutationScopes(
    {
      queueName: 'fpl-critical-sync',
      jobName: 'core-snapshot-publication-reconcile',
      scopes: ['data-core:publication'],
    },
    () =>
      syncOperationsRepository.activatePublication({
        publicationId: pending.publicationId,
        dataset: 'fpl:core',
        season,
        sourceRunId,
        manifest: cached.manifest,
        outbox: { outboxId: randomUUID() },
      }),
  );
  await dispatchDataPublicationOutbox({ limit: 1, publicationId: pending.publicationId });
  logInfo('Recovered ops authority from a complete active core cache manifest', {
    season: season.seasonCode,
    revision: pending.revision,
    publicationId: pending.publicationId,
  });
  return 'activated';
}
