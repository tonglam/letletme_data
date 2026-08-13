import {
  publishCoreSnapshotCache,
  readCoreSnapshotCache,
  type CoreSnapshotCachePublication,
} from '../cache/core-snapshot-cache';
import { explicitSeasonRef, type FplSeasonRef } from '../domain/fpl-season';
import { seasonRepository } from '../repositories/seasons';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  persistCoreSnapshot,
  readCoreSnapshotOrderingTimestamp,
  type CoreSnapshotPersistenceResult,
} from './core-snapshot-persistence.service';
import { refreshPlayerSeasonSummaries } from './player-season-summaries.service';

import type { CoreSnapshot } from '../domain/core-snapshot';

export interface CoreSnapshotPublicationContext {
  readonly revision: number;
  readonly publicationId: string;
  readonly sourceRunId: string;
  readonly sourceCheckedAt: Date;
}

export interface CoreSnapshotCommitResult {
  readonly status: 'committed' | 'stale';
  readonly persistence: CoreSnapshotPersistenceResult;
  readonly publication: CoreSnapshotCachePublication;
}

export { readCoreSnapshotOrderingTimestamp };

export async function commitCoreSnapshotPublication(
  snapshot: CoreSnapshot,
  context: CoreSnapshotPublicationContext,
): Promise<CoreSnapshotCommitResult> {
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
  let cachePublished = false;
  try {
    const publication = await publishCoreSnapshotCache(persisted.snapshot, {
      revision: context.revision,
      publicationId: context.publicationId,
      sourceCheckedAt: context.sourceCheckedAt,
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
    cachePublished = true;
    await syncOperationsRepository.activatePublication({
      publicationId: context.publicationId,
      dataset: 'fpl:core',
      season,
      sourceRunId: context.sourceRunId,
      manifest: publication.manifest,
    });
    return { status: 'committed', persistence: persisted.persistence, publication };
  } catch (error) {
    // Once the atomic pointer moved, keep the ops row staging. Startup recovery can safely
    // activate it from the complete cache manifest; marking it failed would lose that evidence.
    if (!cachePublished) {
      await syncOperationsRepository.failPublication(context.publicationId, error);
    }
    throw error;
  }
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
    throw new DatabaseError(
      'Active core cache manifest has no recoverable ops publication',
      'CORE_PUBLICATION_RECOVERY_CONTRACT_MISMATCH',
    );
  }

  await syncOperationsRepository.activatePublication({
    publicationId: pending.publicationId,
    dataset: 'fpl:core',
    season,
    sourceRunId: pending.sourceRunId,
    manifest: cached.manifest,
  });
  logInfo('Recovered ops authority from a complete active core cache manifest', {
    season: season.seasonCode,
    revision: pending.revision,
    publicationId: pending.publicationId,
  });
  return 'activated';
}
