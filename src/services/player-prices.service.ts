import { playersCache } from '../cache/operations';
import { playerValuesRepository } from '../repositories/player-values';
import { playerRepository } from '../repositories/players';
import { logInfo } from '../utils/logger';
import { getPlayerValueSeasonFloorForDate } from '../utils/player-value-season';

export type PlayerPricesSyncDependencies = {
  findByChangeDate: typeof playerValuesRepository.findByChangeDate;
  findLatestForPlayerIds: typeof playerValuesRepository.findLatestForPlayerIds;
  findDistinctPlayerIds: typeof playerValuesRepository.findDistinctPlayerIds;
  updatePrices: typeof playerRepository.updatePrices;
  mergePlayersCache: typeof playersCache.merge;
};

const defaultDependencies: PlayerPricesSyncDependencies = {
  findByChangeDate: playerValuesRepository.findByChangeDate,
  findLatestForPlayerIds: playerValuesRepository.findLatestForPlayerIds,
  findDistinctPlayerIds: playerValuesRepository.findDistinctPlayerIds,
  updatePrices: playerRepository.updatePrices,
  mergePlayersCache: playersCache.merge,
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

    // The date selects the affected players, while the latest row selects the
    // value. A delayed replay of an older date therefore cannot regress a
    // player who has changed again since that date.
    const latestRows = await dependencies.findLatestForPlayerIds(changedIds);
    const latestById = new Map(latestRows.map((row) => [row.elementId, row]));
    const missingLatest = changedIds.filter((elementId) => !latestById.has(elementId));
    if (missingLatest.length > 0) {
      throw new Error(`Latest player values missing for IDs: ${missingLatest.join(', ')}`);
    }

    const priceUpdates = changedIds.map((elementId) => ({
      elementId,
      value: latestById.get(elementId)!.value,
    }));
    const updatedPlayers = await dependencies.updatePrices(priceUpdates);
    const updatedIds = new Set(updatedPlayers.map((player) => player.id));
    const missingPlayers = changedIds.filter((elementId) => !updatedIds.has(elementId));
    if (missingPlayers.length > 0) {
      throw new Error(`Player rows missing for price update: ${missingPlayers.join(', ')}`);
    }

    // The season's player-value seed is captured from the complete published
    // bootstrap roster. Do not use the single-season players table here: its
    // retained prior-roster IDs are valid history owners but not cache fields.
    const seasonFloor = getPlayerValueSeasonFloorForDate(changeDate);
    const publishedPlayerIds = await dependencies.findDistinctPlayerIds(seasonFloor, changeDate);
    await dependencies.mergePlayersCache(updatedPlayers, publishedPlayerIds);
    logInfo('Player prices updated in database and cache', {
      changeDate,
      count: updatedPlayers.length,
    });

    return { count: updatedPlayers.length, changeDate };
  };
}

export const syncPlayerPricesForDate = createPlayerPricesSync(defaultDependencies);
