import { playersCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { playerValuesRepository } from '../repositories/player-values';
import { playerRepository } from '../repositories/players';
import { transformPlayers } from '../transformers/players';
import { logInfo } from '../utils/logger';
import { getPlayerValueSeasonBounds } from '../utils/player-value-season';

export type PlayerPricesSyncDependencies = {
  findByChangeDate: typeof playerValuesRepository.findByChangeDate;
  findLatestForPlayerIds: typeof playerValuesRepository.findLatestForPlayerIds;
  getBootstrap: typeof fplClient.getBootstrap;
  updatePrices: typeof playerRepository.updatePrices;
  mergePlayerPricesCache: typeof playersCache.mergePrices;
};

const defaultDependencies: PlayerPricesSyncDependencies = {
  findByChangeDate: playerValuesRepository.findByChangeDate,
  findLatestForPlayerIds: playerValuesRepository.findLatestForPlayerIds,
  getBootstrap: () => fplClient.getBootstrap(),
  updatePrices: playerRepository.updatePrices,
  mergePlayerPricesCache: playersCache.mergePrices,
};

export function createPlayerPricesSync(dependencies: PlayerPricesSyncDependencies) {
  return async function syncForDate(
    changeDate: string,
  ): Promise<{ count: number; changeDate: string }> {
    if (!/^\d{8}$/.test(changeDate)) {
      throw new Error(`Invalid player price change date: ${changeDate}`);
    }

    const rowsForDate = await dependencies.findByChangeDate(changeDate);
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
      currentChangedIds,
      fromChangeDate,
      beforeChangeDate,
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
    const updatedPlayers = await dependencies.updatePrices(priceUpdates);
    const updatedIds = new Set(updatedPlayers.map((player) => player.id));
    const missingPlayers = currentChangedIds.filter((elementId) => !updatedIds.has(elementId));
    if (missingPlayers.length > 0) {
      throw new Error(`Player rows missing for price update: ${missingPlayers.join(', ')}`);
    }

    await dependencies.mergePlayerPricesCache(priceUpdates, publishedPlayerIds);
    logInfo('Player prices updated in database and cache', {
      changeDate,
      count: updatedPlayers.length,
    });

    return { count: updatedPlayers.length, changeDate };
  };
}

export const syncPlayerPricesForDate = createPlayerPricesSync(defaultDependencies);
