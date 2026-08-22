import {
  activateDataPublicationPointer,
  compareAndSwapDataPublicationPointer,
  readActiveDataPublication,
  stageDataPublication,
  type DataPublicationScope,
} from '../cache/data-publication';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  loadDataPublicationDelivery,
  markDataPublicationOutboxReconciled,
} from '../repositories/data-publication-outbox';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { eventRepository } from '../repositories/events';
import { randomUUID } from 'node:crypto';
import { dispatchDataPublicationOutbox } from '../repositories/data-publication-outbox';
import { logInfo, logWarn } from '../utils/logger';

export type DataPublicationReconciliationResult = Readonly<{
  status: 'matched' | 'repaired' | 'ghost' | 'missing';
  dataset: DataPublicationScope['dataset'];
  publicationId?: string;
}>;

/**
 * Reconcile the rebuildable Redis pointer against the canonical DB active
 * publication.  A Redis-only publication is reported as a ghost; it is never
 * promoted into PostgreSQL and never removed with an unconditional DEL.
 */
export async function reconcileDataPublication(
  scope: DataPublicationScope,
  season: FplSeasonRef,
): Promise<DataPublicationReconciliationResult> {
  const dbActive = await syncOperationsRepository.findActivePublication(
    scope.dataset,
    season,
    scope.eventId,
  );
  const redisActive = await readActiveDataPublication(scope);
  const staging = await syncOperationsRepository.findStagingPublication(
    scope.dataset,
    season,
    scope.eventId,
  );
  if (staging) {
    let stagingWasActivated = false;
    try {
      const prepared = await loadDataPublicationDelivery(staging.publicationId);
      await stageDataPublication(prepared);
      await syncOperationsRepository.activatePublication({
        publicationId: staging.publicationId,
        dataset: scope.dataset,
        season,
        ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
        sourceRunId: staging.sourceRunId,
        manifest: prepared.manifest,
        outbox: { outboxId: randomUUID() },
      });
      stagingWasActivated = true;
      await dispatchDataPublicationOutbox({
        limit: 1,
        publicationId: staging.publicationId,
      });
      logInfo('Completed staged Data publication reconciliation', {
        dataset: scope.dataset,
        season: scope.seasonCode,
        eventId: scope.eventId,
        publicationId: staging.publicationId,
      });
      return {
        status: 'repaired',
        dataset: scope.dataset,
        publicationId: staging.publicationId,
      };
    } catch (error) {
      logWarn('Data publication staging exists but is not yet recoverable', {
        dataset: scope.dataset,
        season: scope.seasonCode,
        eventId: scope.eventId,
        publicationId: staging.publicationId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      // Once DB activation has committed, returning a stale "matched" result
      // would hide an outbox/Redis delivery failure. Let the scheduler pass
      // surface the failure and retry the durable outbox instead.
      if (stagingWasActivated) throw error;
    }
  }
  if (!dbActive) {
    if (redisActive) {
      logWarn('Redis data publication has no canonical DB publication', {
        dataset: scope.dataset,
        season: scope.seasonCode,
        eventId: scope.eventId,
        publicationId: redisActive.manifest.publicationId,
      });
      return {
        status: 'ghost',
        dataset: scope.dataset,
        publicationId: redisActive.manifest.publicationId,
      };
    }
    return { status: 'missing', dataset: scope.dataset };
  }

  const canonical = await loadDataPublicationDelivery(dbActive.publicationId);
  if (
    redisActive?.manifest.publicationId === canonical.manifest.publicationId &&
    redisActive.manifest.revision === canonical.manifest.revision
  ) {
    return {
      status: 'matched',
      dataset: scope.dataset,
      publicationId: canonical.manifest.publicationId,
    };
  }

  // Prefer the durable receipt created in the same DB activation transaction.
  // This is the normal crash-recovery path after Redis staging or CAS was
  // interrupted; the fallback below is only for legacy publications that have
  // no outbox row yet.
  const outboxDelivery = await dispatchDataPublicationOutbox({
    limit: 1,
    publicationId: dbActive.publicationId,
  });
  if (outboxDelivery.delivered === 1) {
    return {
      status: 'repaired',
      dataset: scope.dataset,
      publicationId: canonical.manifest.publicationId,
    };
  }

  await stageDataPublication(canonical);
  if (!redisActive) {
    const activated = await activateDataPublicationPointer(canonical.manifest);
    if (activated.status === 'stale') {
      throw new Error(`Redis publication changed while repairing ${scope.dataset}`);
    }
  } else {
    const result = await compareAndSwapDataPublicationPointer(
      scope,
      redisActive.manifest.publicationId,
      canonical.manifest,
    );
    if (result !== 'replaced') {
      throw new Error(`Redis publication changed while repairing ${scope.dataset}: ${result}`);
    }
  }
  // A prior dispatcher may have marked this immutable receipt failed after it
  // observed a newer Redis pointer. Once the compare-if-current repair above
  // has succeeded, close that receipt and its source run as delivered too;
  // otherwise readiness would remain stuck on a row that is already canonical
  // in both stores.
  await markDataPublicationOutboxReconciled({ publicationId: dbActive.publicationId });
  logInfo('Repaired Redis data publication pointer from canonical DB', {
    dataset: scope.dataset,
    season: scope.seasonCode,
    eventId: scope.eventId,
    publicationId: canonical.manifest.publicationId,
  });
  return {
    status: 'repaired',
    dataset: scope.dataset,
    publicationId: canonical.manifest.publicationId,
  };
}

export async function reconcileCoreAndMarketPublications(
  season: FplSeasonRef,
): Promise<readonly DataPublicationReconciliationResult[]> {
  const currentEvent = await eventRepository.findCurrent(season);
  return Promise.all([
    reconcileDataPublication({ dataset: 'fpl:core', seasonCode: season.seasonCode }, season),
    reconcileDataPublication({ dataset: 'fpl:market', seasonCode: season.seasonCode }, season),
    ...(currentEvent
      ? [
          reconcileDataPublication(
            { dataset: 'fpl:live', seasonCode: season.seasonCode, eventId: currentEvent.id },
            season,
          ),
        ]
      : []),
  ]);
}
