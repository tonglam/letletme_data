import {
  finalizeCoreSnapshotCachePublication,
  publishCoreSnapshotCache,
  readPendingCoreSnapshotCachePublication,
  rollbackCoreSnapshotCachePublication,
  type CoreSnapshotCachePublication,
} from '../cache/core-snapshot-cache';
import { events } from '../db/schemas/index.schema';
import { findCoreSnapshotAuthority } from '../repositories/core-snapshot-authority';
import { createPlayerRepository } from '../repositories/players';
import { CacheError } from '../utils/errors';
import { logInfo } from '../utils/logger';
import {
  persistCoreSnapshotWithFinalizer,
  readCoreSnapshotOrderingTimestamp,
  type CoreSnapshotCommitResult,
  withCoreSnapshotAuthorityLock,
} from './core-snapshot-persistence.service';
import { reconcileCoreFixtureDerivatives } from './core-fixture-derivatives.service';

import type { TransactionHandle } from '../db/singleton';

import type { CoreSnapshot } from '../domain/core-snapshot';

export interface CoreSnapshotPublicationContext {
  revision: number;
  publicationId: string;
  previousActiveSeason: string | null;
  sourceCheckedAt: Date;
}

export { readCoreSnapshotOrderingTimestamp };

function requireReceipt(publication: CoreSnapshotCachePublication) {
  if (!publication.published || !publication.receipt) {
    throw new CacheError(
      'Core snapshot cache publication did not produce a recovery receipt',
      'CORE_SNAPSHOT_PUBLICATION_LOST_AUTHORITY',
    );
  }
  return publication.receipt;
}

async function finalizeCommittedPublication(
  receipt: ReturnType<typeof requireReceipt>,
): Promise<void> {
  await reconcileCoreFixtureDerivatives(receipt.fixtureIds, new Date(receipt.sourceCheckedAt));
  await finalizeCoreSnapshotCachePublication(receipt);
}

async function rollbackWithDurablePartialWinners(
  receipt: ReturnType<typeof requireReceipt>,
  transaction: TransactionHandle,
): Promise<void> {
  // Match core persistence lock order. A partial writer that completed first
  // is visible here; one that starts later waits and republishes after recovery.
  const durablePlayers = await createPlayerRepository(transaction).findAll({ lock: true });
  await transaction.select({ id: events.id }).from(events).for('update');
  await rollbackCoreSnapshotCachePublication(receipt, undefined, durablePlayers);
}

export async function commitCoreSnapshotPublication(
  snapshot: CoreSnapshot,
  context: CoreSnapshotPublicationContext,
): Promise<CoreSnapshotCommitResult<CoreSnapshotCachePublication>> {
  return persistCoreSnapshotWithFinalizer(snapshot, {
    revision: context.revision,
    publicationId: context.publicationId,
    previousActiveSeason: context.previousActiveSeason,
    sourceCheckedAt: context.sourceCheckedAt,
    finalize: async (reconciledSnapshot) => {
      const publication = await publishCoreSnapshotCache(reconciledSnapshot, {
        publicationId: context.publicationId,
        sourceCheckedAt: context.sourceCheckedAt,
      });
      requireReceipt(publication);
      return publication;
    },
    compensate: async (publication) => {
      await withCoreSnapshotAuthorityLock((transaction) =>
        rollbackWithDurablePartialWinners(requireReceipt(publication), transaction),
      );
    },
    afterCommit: async (publication) => {
      await finalizeCommittedPublication(requireReceipt(publication));
    },
  });
}

export async function recoverPendingCoreSnapshotPublication(): Promise<
  'none' | 'finalized' | 'rolled_back'
> {
  const decision = await withCoreSnapshotAuthorityLock(async (transaction) => {
    // Read the receipt only after acquiring the same database lock used by a
    // publisher. Recovery can then never mistake an in-flight transaction for
    // a rolled-back publication, even if the Redis mutation guard is disabled
    // or its lease is lost.
    const pending = await readPendingCoreSnapshotCachePublication();
    if (!pending) return 'none';

    const authority = await findCoreSnapshotAuthority(transaction, { lock: true });
    if (authority?.publicationId === pending.publicationId) {
      return { status: 'committed' as const, pending };
    }

    await rollbackWithDurablePartialWinners(pending, transaction);
    logInfo('Rolled back uncommitted core snapshot publication recovery', {
      season: pending.season,
      publicationId: pending.publicationId,
    });
    return { status: 'rolled_back' as const };
  });

  if (decision === 'none') return 'none';
  if (decision.status === 'rolled_back') return 'rolled_back';

  // Event serialization takes the shared season fence, so committed recovery
  // completes after releasing the core authority transaction's write fence.
  // The Redis receipt remains pending until every derivative is reconciled;
  // any failure is therefore recoverable by the next attempt.
  await finalizeCommittedPublication(decision.pending);
  logInfo('Finalized committed core snapshot publication recovery', {
    season: decision.pending.season,
    publicationId: decision.pending.publicationId,
  });
  return 'finalized';
}
