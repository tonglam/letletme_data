import { randomUUID } from 'node:crypto';

import {
  publishDataRevision,
  readActiveDataPublication,
  type MarketSnapshotContextPayload,
} from '../cache/data-publication';
import type { FplSeasonRef } from '../domain/fpl-season';
import { playerMarketSnapshotsRepository } from '../repositories/player-market-snapshots';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { logInfo } from '../utils/logger';

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

export async function ensureMarketPublication(
  season: FplSeasonRef,
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

  const sourceRunId = randomUUID();
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
  let cachePublished = false;
  try {
    const prepared = await syncOperationsRepository.preparePublication({
      publicationId,
      dataset: 'fpl:market',
      season,
      sourceRunId,
      manifest: { state: 'staging', sourceCheckedAt: source.capturedAt.toISOString() },
    });
    const published = await publishDataRevision({
      dataset: 'fpl:market',
      seasonCode: season.seasonCode,
      revision: prepared.revision,
      publicationId: prepared.publicationId,
      sourceCheckedAt: source.capturedAt,
      state: 'active',
      items: [{ name: 'context', value: context }],
    });
    if (published.status === 'stale') {
      await syncOperationsRepository.skipPublication(
        prepared.publicationId,
        'A newer market publication already owns the cache scope',
      );
      await syncOperationsRepository.finishRun(sourceRunId, {
        status: 'skipped',
        completedItems: 0,
        skippedItems: 1,
        dataChanged: false,
      });
      return { status: 'unchanged', context };
    }
    cachePublished = true;
    await syncOperationsRepository.activatePublication({
      publicationId: prepared.publicationId,
      dataset: 'fpl:market',
      season,
      sourceRunId,
      manifest: published.manifest,
    });
    await syncOperationsRepository.finishRun(sourceRunId, {
      status: 'published',
      completedItems: 1,
      skippedItems: 0,
      dataChanged: true,
      publicationId: prepared.publicationId,
      metadata: {
        snapshotDate: context.snapshotDate,
        rowCount: context.rowCount,
        revision: prepared.revision,
      },
    });
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
    if (!cachePublished)
      await syncOperationsRepository.failPublication(publicationId, error).catch(() => undefined);
    throw error;
  }
}
