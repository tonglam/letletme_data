import { randomUUID } from 'node:crypto';

import {
  prepareDataPublication,
  readActiveDataPublication,
  type MarketSnapshotContextPayload,
} from '../cache/data-publication';
import type { FplSeasonRef } from '../domain/fpl-season';
import { playerMarketSnapshotsRepository } from '../repositories/player-market-snapshots';
import { syncOperationsRepository } from '../repositories/sync-operations';
import {
  dispatchDataPublicationOutbox,
  loadDataPublicationDelivery,
} from '../repositories/data-publication-outbox';
import { contentHash } from '../utils/content-hash';
import { logInfo } from '../utils/logger';
import { formatCronDateKey } from '../utils/timezone';

export type MarketPublicationResult = {
  readonly status: 'published' | 'unchanged' | 'empty';
  readonly revision?: number;
  readonly publicationId?: string;
  readonly context?: MarketSnapshotContextPayload;
};

const marketScope = (season: FplSeasonRef) => ({
  dataset: 'fpl:market' as const,
  seasonCode: season.seasonCode,
});

export type MarketPublicationOptions = Readonly<{
  /**
   * Keep DB activation and the outbox receipt in the caller's mutation
   * transaction. The caller must dispatch the receipt after that transaction
   * commits; Redis is never touched while the canonical transaction is open.
   */
  deferDelivery?: boolean;
  /** Correlate the publication run with its scheduler/Bull obligation. */
  sourceRunId?: string;
  /** Exact freshness window being repaired, carried into the manifest. */
  freshnessWindowId?: number;
}>;

async function ensureMarketPublicationDelivered(
  season: FplSeasonRef,
  publicationId: string,
  revision: number,
): Promise<void> {
  const delivered = await dispatchDataPublicationOutbox({
    limit: 1,
    publicationId,
  });
  if (delivered.delivered === 1) return;

  // A retry may observe an already-delivered receipt (or a legacy active
  // publication created before the outbox migration).  Re-read the active
  // pointer before reporting a delivery failure; DB and Redis parity is the
  // success evidence, not whether this particular dispatch claimed a row.
  const active = await readActiveDataPublication(marketScope(season));
  if (active?.manifest.publicationId === publicationId && active.manifest.revision === revision) {
    return;
  }
  throw new Error(`Market publication ${publicationId} is canonical but Redis delivery is pending`);
}

export async function ensureMarketPublication(
  season: FplSeasonRef,
  options: MarketPublicationOptions = {},
): Promise<MarketPublicationResult> {
  const source = await playerMarketSnapshotsRepository.getLatestCompleteSnapshot(season);
  if (!source) return { status: 'empty' };

  const context: MarketSnapshotContextPayload = {
    seasonCode: season.seasonCode,
    snapshotDate: source.snapshotDate,
    capturedAt: source.capturedAt.toISOString(),
    latestMutationAt: source.capturedAt.toISOString(),
    sourceEventId: source.sourceEventId,
    rowCount: source.rowCount,
    expectedRowCount: source.rowCount,
  };
  const active = await readActiveDataPublication(marketScope(season));
  const opsActive = await syncOperationsRepository.findActivePublication('fpl:market', season);
  if (!opsActive && active && context.snapshotDate.replaceAll('-', '') !== formatCronDateKey()) {
    // A Redis-only publication for a past UTC+8 date is a ghost. Do not
    // promote an older mutable snapshot merely to make readiness green; the
    // current-day scheduler obligation must first obtain an authoritative
    // snapshot or record the date as irrecoverable.
    return { status: 'empty' };
  }
  const activeContext = active?.items.context as Partial<MarketSnapshotContextPayload> | undefined;
  if (
    active &&
    opsActive &&
    opsActive.revision === active.manifest.revision &&
    opsActive.publicationId === active.manifest.publicationId &&
    activeContext?.snapshotDate === context.snapshotDate &&
    activeContext?.capturedAt === context.capturedAt &&
    activeContext?.rowCount === context.rowCount
  ) {
    return {
      status: 'unchanged',
      revision: active.manifest.revision,
      publicationId: active.manifest.publicationId,
      context,
    };
  }

  // A prior worker may have committed the canonical publication and then
  // died before delivering its outbox row. Reuse that proof rather than
  // creating another revision for the same snapshot. This path is safe even
  // when Redis is stale because the outbox is delivered only after the DB row
  // is already active.
  if (opsActive && (!active || opsActive.publicationId !== active.manifest.publicationId)) {
    const committed = await loadDataPublicationDelivery(opsActive.publicationId).catch(() => null);
    const committedContext = committed?.items.find((item) => item.manifest.name === 'context');
    let committedContextValue: Partial<MarketSnapshotContextPayload> | null = null;
    try {
      committedContextValue = committedContext
        ? (JSON.parse(committedContext.payload) as Partial<MarketSnapshotContextPayload>)
        : null;
    } catch {
      committedContextValue = null;
    }
    if (
      committedContextValue?.snapshotDate === context.snapshotDate &&
      committedContextValue.capturedAt === context.capturedAt
    ) {
      if (!options.deferDelivery) {
        await ensureMarketPublicationDelivered(season, opsActive.publicationId, opsActive.revision);
      }
      return {
        status: 'published',
        revision: opsActive.revision,
        publicationId: opsActive.publicationId,
        context,
      };
    }
  }

  const sourceRunId = options.sourceRunId ?? randomUUID();
  await syncOperationsRepository.startRun({
    runId: sourceRunId,
    provider: 'fpl',
    lane: 'market',
    scope: 'market-publication',
    season,
    mode: 'publication',
    trigger: 'queue',
    expectedItems: 1,
  });
  const publicationId = randomUUID();
  const outboxId = randomUUID();
  let dbActivated = false;
  try {
    const prepared = await syncOperationsRepository.preparePublication({
      publicationId,
      dataset: 'fpl:market',
      season,
      sourceRunId,
      manifest: { state: 'staging', sourceCheckedAt: source.capturedAt.toISOString() },
    });
    const preparedData = prepareDataPublication({
      dataset: 'fpl:market',
      seasonCode: season.seasonCode,
      revision: prepared.revision,
      publicationId: prepared.publicationId,
      sourceCheckedAt: source.capturedAt,
      freshnessWindowId: options.freshnessWindowId,
      state: 'active',
      items: [{ name: 'context', value: context }],
    });
    const contextItem = preparedData.items[0];
    if (!contextItem) throw new Error('Market publication context proof is missing');
    await syncOperationsRepository.stagePublicationItems(prepared.publicationId, [
      {
        name: 'context',
        payload: context,
        count: contextItem.manifest.count,
        checksum: contentHash(context),
      },
    ]);
    await syncOperationsRepository.activatePublication({
      publicationId: prepared.publicationId,
      dataset: 'fpl:market',
      season,
      sourceRunId,
      manifest: preparedData.manifest,
      outbox: { outboxId },
    });
    dbActivated = true;
    if (!options.deferDelivery) {
      await ensureMarketPublicationDelivered(season, prepared.publicationId, prepared.revision);
    }
    logInfo('Market Data publication activated', {
      season: season.seasonCode,
      revision: prepared.revision,
      snapshotDate: context.snapshotDate,
      rowCount: context.rowCount,
    });
    return {
      status: 'published',
      revision: prepared.revision,
      publicationId: prepared.publicationId,
      context,
    };
  } catch (error) {
    if (!dbActivated)
      await syncOperationsRepository.failPublication(publicationId, error).catch(() => undefined);
    throw error;
  }
}
