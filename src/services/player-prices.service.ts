import { fplClient } from '../clients/fpl';
import { enqueueCoreSnapshotJob } from '../jobs/data-sync-enqueue';
import { playerValuesRepository } from '../repositories/player-values';
import { playerRepository } from '../repositories/players';
import type { FplSeasonRef } from '../domain/fpl-season';
import { transformPlayers } from '../transformers/players';
import { logInfo } from '../utils/logger';
import { getPlayerValueSeasonBounds } from '../utils/player-value-season';
import { readCoreSnapshotOrderingTimestamp } from './core-snapshot-persistence.service';

export type PlayerPricesSyncDependencies = {
  findByChangeDate: typeof playerValuesRepository.findByChangeDate;
  findLatestForPlayerIds: typeof playerValuesRepository.findLatestForPlayerIds;
  getBootstrap: typeof fplClient.getBootstrap;
  updatePrices: typeof playerRepository.updatePrices;
  enqueueCoreSnapshot: typeof enqueueCoreSnapshotJob;
  readOrderingTimestamp: typeof readCoreSnapshotOrderingTimestamp;
};

const defaultDependencies: PlayerPricesSyncDependencies = {
  findByChangeDate: playerValuesRepository.findByChangeDate,
  findLatestForPlayerIds: playerValuesRepository.findLatestForPlayerIds,
  getBootstrap: () => fplClient.getBootstrap(),
  updatePrices: playerRepository.updatePrices,
  enqueueCoreSnapshot: enqueueCoreSnapshotJob,
  readOrderingTimestamp: readCoreSnapshotOrderingTimestamp,
};

export function createPlayerPricesSync(dependencies: PlayerPricesSyncDependencies) {
  return async function syncForDate(
    season: FplSeasonRef,
    changeDate: string,
  ): Promise<{ count: number; changeDate: string }> {
    if (!/^\d{8}$/.test(changeDate)) {
      throw new Error(`Invalid player price change date: ${changeDate}`);
    }

    const rowsForDate = await dependencies.findByChangeDate(season, changeDate);
    const changedIds = Array.from(
      new Set(
        rowsForDate
          .filter((row) => row.changeType === 'Rise' || row.changeType === 'Faller')
          .map((row) => row.elementId),
      ),
    );

    if (changedIds.length === 0) {
      logInfo('No player price changes to apply', { changeDate });
      return { count: 0, changeDate };
    }

    // Use PostgreSQL time captured before price source reads so this evidence
    // is directly comparable with a core snapshot's pre-fetch ordering marker.
    const sourceCheckedAt = await dependencies.readOrderingTimestamp();

    const bootstrap = await dependencies.getBootstrap();
    if (!Array.isArray(bootstrap.elements) || bootstrap.elements.length === 0) {
      throw new Error('No published player roster returned from FPL API');
    }
    // The full players sync publishes only elements that pass the player
    // transformer. Use the same roster here so the partial-merge guard checks
    // the exact field set that syncPlayers writes, not unpublishable raw rows.
    const publishedPlayerIds = Array.from(
      new Set(transformPlayers(bootstrap.elements).map((player) => player.id)),
    );
    if (publishedPlayerIds.length === 0) {
      throw new Error('No valid published player roster returned from FPL API');
    }
    const publishedIdSet = new Set(publishedPlayerIds);
    const currentChangedIds = changedIds.filter((elementId) => publishedIdSet.has(elementId));
    if (currentChangedIds.length === 0) {
      logInfo('Affected price rows no longer belong to the published roster', { changeDate });
      return { count: 0, changeDate };
    }
    const gw1Deadline = bootstrap.events.find((event) => event.id === 1)?.deadline_time ?? null;
    const { fromChangeDate, beforeChangeDate } = getPlayerValueSeasonBounds(gw1Deadline);

    // The date selects the affected players, while the latest row selects the
    // value. A delayed replay of an older date therefore cannot regress a
    // player who has changed again since that date. The published-season
    // bounds prevent a reused FPL element ID from reading prior-season history.
    const latestRows = await dependencies.findLatestForPlayerIds(
      season,
      currentChangedIds,
      fromChangeDate,
      beforeChangeDate,
      sourceCheckedAt,
    );
    const latestById = new Map(latestRows.map((row) => [row.elementId, row]));
    const missingLatest = currentChangedIds.filter((elementId) => !latestById.has(elementId));
    if (missingLatest.length > 0) {
      throw new Error(`Latest player values missing for IDs: ${missingLatest.join(', ')}`);
    }

    const priceUpdates = currentChangedIds.map((elementId) => ({
      elementId,
      value: latestById.get(elementId)!.value,
    }));
    const updatedPlayers = await dependencies.updatePrices(season, priceUpdates, sourceCheckedAt);
    const updatedIds = new Set(updatedPlayers.map((player) => player.id));
    const winningPriceUpdates = priceUpdates.filter((update) => updatedIds.has(update.elementId));
    const skippedIds = currentChangedIds.filter((elementId) => !updatedIds.has(elementId));
    if (skippedIds.length > 0) {
      logInfo('Skipped stale player price updates', {
        changeDate,
        count: skippedIds.length,
      });
    }

    if (winningPriceUpdates.length > 0) {
      await dependencies.enqueueCoreSnapshot(season, 'cascade', {
        jobId: `core-after-price-${changeDate}`,
        removeOnSettle: false,
      });
    }
    logInfo('Player prices updated; coherent core rebuild queued', {
      changeDate,
      count: updatedPlayers.length,
    });

    return { count: updatedPlayers.length, changeDate };
  };
}

export const syncPlayerPricesForDate = createPlayerPricesSync(defaultDependencies);
