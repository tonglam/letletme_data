import {
  activateDataPublicationPointer,
  compareAndSwapDataPublicationPointer,
  repairDataPublicationItems,
  readActiveDataPublication,
  readActiveDataPublicationManifest,
  stageDataPublication,
  type DataPublicationScope,
} from '../cache/data-publication';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  loadDataPublicationDelivery,
  loadDataPublicationDeliveryManifest,
  validateAndMarkDataPublicationProof,
} from '../repositories/data-publication-outbox';
import {
  dispatchDataPublicationOutbox,
  markDataPublicationOutboxReconciled,
} from './data-publication-delivery.service';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { getSchedulerLane } from '../repositories/scheduler-lanes';
import { randomUUID } from 'node:crypto';
import { logInfo, logWarn } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import { parseStrictBooleanEnvValue } from '../utils/config';

export type DataPublicationReconciliationResult = Readonly<{
  status: 'matched' | 'repaired' | 'ghost' | 'missing' | 'failed';
  dataset: DataPublicationScope['dataset'];
  publicationId?: string;
}>;

const PRICE_CHANGE_STAGING_ORPHAN_AFTER_MS = 2 * 60_000;

function priceChangeSingleFlightEnabled(): boolean {
  return parseStrictBooleanEnvValue(
    process.env.PRICE_CHANGE_SINGLE_FLIGHT_ENABLED,
    process.env.NODE_ENV !== 'production',
    'PRICE_CHANGE_SINGLE_FLIGHT_ENABLED',
  );
}

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
  // Reconciliation is the repair boundary, so it must detect same-length
  // Redis corruption before declaring a publication matched. This validates
  // the payload hashes/counts in Redis; it does not reread PostgreSQL data.
  const redisActiveRead = await readActiveDataPublication(scope);
  const redisActive = redisActiveRead?.manifest ?? null;
  const redisManifest =
    redisActive ?? (await readActiveDataPublicationManifest(scope).catch(() => null));
  let staging = await syncOperationsRepository.findStagingPublication(
    scope.dataset,
    season,
    scope.eventId,
  );
  if (staging && scope.dataset === 'fpl:price-changes' && priceChangeSingleFlightEnabled()) {
    const lane = await getSchedulerLane({
      laneKey: `fpl-price-changes-${season.seasonCode}`,
    });
    const stagingAgeMs = Date.now() - staging.createdAt.getTime();
    const expired = staging.expiresAt !== null && staging.expiresAt.getTime() <= Date.now();
    if (
      lane?.state === 'running' &&
      !expired &&
      stagingAgeMs < PRICE_CHANGE_STAGING_ORPHAN_AFTER_MS
    ) {
      // A live lane owns this short-lived staging row. Leave it for the
      // worker's publication fence; the generic reconciler must not promote
      // a result outside the latest-wins CAS.
      logWarn('Price-change staging is owned by the active scheduler lane', {
        dataset: scope.dataset,
        season: scope.seasonCode,
        publicationId: staging.publicationId,
        laneId: lane.laneId,
        ageMs: Math.max(0, stagingAgeMs),
      });
      staging = null;
    } else {
      // A waiting, blocked, idle, or expired lane cannot safely adopt this
      // payload. Retire the immutable staging row and its source run so one
      // crashed preparation cannot block every later deployment. The lane
      // will refetch the latest desired obligation on its next dispatch.
      await syncOperationsRepository.skipPublication(
        staging.publicationId,
        'orphaned-price-change-staging-after-latest-wins-cutover',
      );
      logInfo('Retired orphaned price-change staging publication', {
        dataset: scope.dataset,
        season: scope.seasonCode,
        publicationId: staging.publicationId,
        laneState: lane?.state ?? 'missing',
        ageMs: Math.max(0, stagingAgeMs),
      });
      staging = null;
    }
  }
  if (staging) {
    let stagingWasActivated = false;
    try {
      const prepared = await loadDataPublicationDelivery(staging.publicationId);
      await stageDataPublication(prepared);
      const activate = () =>
        syncOperationsRepository.activatePublication({
          publicationId: staging.publicationId,
          dataset: scope.dataset,
          season,
          ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
          sourceRunId: staging.sourceRunId,
          manifest: prepared.manifest,
          outbox: { outboxId: randomUUID() },
        });
      if (scope.dataset === 'fpl:core') {
        await withMutationScopes(
          {
            queueName: 'fpl-critical-sync',
            jobName: 'core-snapshot-publication-reconcile',
            scopes: ['data-core:publication'],
          },
          activate,
        );
      } else {
        await activate();
      }
      stagingWasActivated = true;
      if (stagingWasActivated) {
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
      }
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
        publicationId: redisActive.publicationId,
      });
      return {
        status: 'ghost',
        dataset: scope.dataset,
        publicationId: redisActive.publicationId,
      };
    }
    return { status: 'missing', dataset: scope.dataset };
  }

  // A Redis identity match is only a control match when the durable
  // publication carries the producer-side proof. Legacy rows remain
  // consumable through the full delivery validator, but they must not be
  // reported as permanently verified by a high-frequency reconciler.
  let durableManifest = await loadDataPublicationDeliveryManifest(dbActive.publicationId).catch(
    () => null,
  );
  if (!durableManifest) {
    // Legacy active rows are upgraded only after this explicit scope has been
    // fully validated. No historical scan or high-frequency payload read is
    // introduced; subsequent reconciliation returns to the proof-only path.
    durableManifest = await validateAndMarkDataPublicationProof(dbActive.publicationId).catch(
      () => null,
    );
  }
  if (
    redisActive?.publicationId === dbActive.publicationId &&
    redisActive.revision === dbActive.revision &&
    durableManifest?.publicationId === dbActive.publicationId &&
    durableManifest.revision === dbActive.revision
  ) {
    return {
      status: 'matched',
      dataset: scope.dataset,
      publicationId: dbActive.publicationId,
    };
  }

  // Only a missing or mismatched identity enters the delivery path. This is
  // where the full payload is needed to repair Redis; normal reconciliation
  // above remains manifest-only.
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
      publicationId: dbActive.publicationId,
    };
  }

  // Only the fallback repair path needs the complete payload. The dispatcher
  // above already loaded and delivered its own claimed receipt, so a healthy
  // outbox does not cause this reconciler to download the same siblings again.
  const canonical = await loadDataPublicationDelivery(dbActive.publicationId);

  if (!redisManifest) {
    await stageDataPublication(canonical);
    const activated = await activateDataPublicationPointer(canonical.manifest);
    if (activated.status === 'stale') {
      throw new Error(`Redis publication changed while repairing ${scope.dataset}`);
    }
  } else if (
    redisManifest.publicationId === canonical.manifest.publicationId &&
    redisManifest.revision === canonical.manifest.revision
  ) {
    // The pointer already identifies this immutable publication, so replacing
    // its damaged siblings is safe and stays inside the Data-owned scope.
    await repairDataPublicationItems(canonical);
    const repaired = await compareAndSwapDataPublicationPointer(
      scope,
      redisManifest.publicationId,
      canonical.manifest,
    );
    if (repaired !== 'replaced') {
      throw new Error(`Redis publication changed while repairing ${scope.dataset}: ${repaired}`);
    }
  } else {
    await stageDataPublication(canonical);
    const result = await compareAndSwapDataPublicationPointer(
      scope,
      redisManifest.publicationId,
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
  const scopes: readonly DataPublicationScope[] = [
    { dataset: 'fpl:core', seasonCode: season.seasonCode },
    { dataset: 'fpl:market', seasonCode: season.seasonCode },
    { dataset: 'fpl:price-changes', seasonCode: season.seasonCode },
  ];
  return Promise.all(
    scopes.map(async (scope): Promise<DataPublicationReconciliationResult> => {
      try {
        return await reconcileDataPublication(scope, season);
      } catch (error) {
        // A malformed legacy active publication must not block the global
        // scheduler. The corresponding durable job will rebuild canonical
        // evidence; readiness remains false until that repair is complete.
        logWarn('Data publication reconciliation failed; scheduler will continue', {
          dataset: scope.dataset,
          season: scope.seasonCode,
          eventId: scope.eventId,
          error: error instanceof Error ? error.message : 'unknown',
        });
        return { status: 'failed', dataset: scope.dataset };
      }
    }),
  );
}
