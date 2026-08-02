import { playerValuesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import type { PlayerValue } from '../domain/player-values';
import { enqueuePlayerPricesSyncJob } from '../jobs/data-sync-enqueue';
import type { StoredPlayerValue } from '../repositories/player-values';
import { playerValuesRepository } from '../repositories/player-values';
import { createTeamsMap, transformPlayerValuesWithChanges } from '../transformers/player-values';
import type { RawFPLElement } from '../types';
import { ELEMENT_TYPE_MAP } from '../types/base.type';
import { notifyTwoBots } from '../utils/notify';
import { logError, logInfo } from '../utils/logger';
import { getPlayerValueSeasonFloor } from '../utils/player-value-season';
import { loadTeamsBasicInfo } from '../utils/teams';
import { formatCronDateKey } from '../utils/timezone';
import { resolvePlayerSyncEvent } from './player-sync-event.service';

export type PlayerValuesSyncDependencies = {
  getBootstrap: typeof fplClient.getBootstrap;
  resolvePlayerSyncEvent: typeof resolvePlayerSyncEvent;
  findLatestForAllPlayers: typeof playerValuesRepository.findLatestForAllPlayers;
  findByChangeDate: typeof playerValuesRepository.findByChangeDate;
  insertBatch: typeof playerValuesRepository.insertBatch;
  loadTeamsBasicInfo: typeof loadTeamsBasicInfo;
  getCachedValues: typeof playerValuesCache.get;
  mergeCachedValues: typeof playerValuesCache.merge;
  enqueuePlayerPrices: typeof enqueuePlayerPricesSyncJob;
  notify: typeof notifyTwoBots;
  getCurrentChangeDate: () => string;
};

const defaultDependencies: PlayerValuesSyncDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  resolvePlayerSyncEvent,
  findLatestForAllPlayers: playerValuesRepository.findLatestForAllPlayers,
  findByChangeDate: playerValuesRepository.findByChangeDate,
  insertBatch: playerValuesRepository.insertBatch,
  loadTeamsBasicInfo,
  getCachedValues: playerValuesCache.get,
  mergeCachedValues: playerValuesCache.merge,
  enqueuePlayerPrices: enqueuePlayerPricesSyncJob,
  notify: notifyTwoBots,
  getCurrentChangeDate: () => formatCronDateKey(),
};

function formatPlayerValuesNotification(
  changeDate: string,
  playerValues: readonly PlayerValue[],
): string {
  const formatPrice = (value: number) => `£${(value / 10).toFixed(1)}m`;
  const nonStart = playerValues.filter((pv) => pv.changeType !== 'Start');
  const risers = nonStart
    .filter((pv) => pv.changeType === 'Rise')
    .slice()
    .sort((a, b) => b.value - b.lastValue - (a.value - a.lastValue));
  const fallers = nonStart
    .filter((pv) => pv.changeType === 'Faller')
    .slice()
    .sort((a, b) => a.value - a.lastValue - (b.value - b.lastValue));

  const header = `[player-values] ${changeDate}: +${risers.length} -${fallers.length} (total ${nonStart.length})`;

  const formatLine = (pv: PlayerValue) => {
    return `${pv.webName} (${pv.teamShortName}) ${formatPrice(pv.lastValue)}-> ${formatPrice(pv.value)}`;
  };

  const top = (items: PlayerValue[]) => items.slice(0, 12).map(formatLine);

  const lines = [header];
  if (risers.length > 0) lines.push('Risers:', ...top(risers));
  if (fallers.length > 0) lines.push('Fallers:', ...top(fallers));

  return lines.join('\n');
}

/**
 * Sync current player values (checks today's date for price changes)
 *
 * This function:
 * 1. Fetches current bootstrap data from FPL API
 * 2. Compares current prices with last stored values
 * 3. Identifies players with price changes for today
 * 4. Stores new price change records with today's changeDate
 * 5. Updates cache with today's changes
 *
 * Player values are date-based (changeDate in YYYYMMDD format)
 */
function playerValueMatches(left: PlayerValue, right: PlayerValue): boolean {
  return (
    left.elementId === right.elementId &&
    left.webName === right.webName &&
    left.eventId === right.eventId &&
    left.elementType === right.elementType &&
    left.elementTypeName === right.elementTypeName &&
    left.teamId === right.teamId &&
    left.teamName === right.teamName &&
    left.teamShortName === right.teamShortName &&
    left.value === right.value &&
    left.lastValue === right.lastValue &&
    left.changeDate === right.changeDate &&
    left.changeType === right.changeType
  );
}

export function findPlayerValueCacheRepairs(
  expected: PlayerValue[],
  cached: PlayerValue[] | null,
): PlayerValue[] {
  const cachedById = new Map((cached ?? []).map((row) => [row.elementId, row]));
  return expected.filter((row) => {
    const cachedRow = cachedById.get(row.elementId);
    return !cachedRow || !playerValueMatches(row, cachedRow);
  });
}

function enrichStoredRows(
  rows: StoredPlayerValue[],
  elementsById: Map<number, RawFPLElement>,
  teamsMap: Map<number, { name: string; shortName: string }>,
): PlayerValue[] {
  return rows.map((row) => {
    const player = elementsById.get(row.elementId);
    if (!player) {
      throw new Error(`Bootstrap player missing for stored value: ${row.elementId}`);
    }
    const team = teamsMap.get(player.team);
    if (!team) {
      throw new Error(`Team missing for stored player value: ${player.team}`);
    }

    return {
      ...row,
      elementType: row.elementType as 1 | 2 | 3 | 4,
      elementTypeName: ELEMENT_TYPE_MAP[row.elementType as 1 | 2 | 3 | 4],
      webName: player.web_name,
      teamId: player.team,
      teamName: team.name,
      teamShortName: team.shortName,
    };
  });
}

export function createPlayerValuesSync(dependencies: PlayerValuesSyncDependencies) {
  return async function syncForDate(
    changeDate: string = formatCronDateKey(),
  ): Promise<{ count: number }> {
    logInfo('Starting daily player values sync');

    if (!/^\d{8}$/.test(changeDate)) {
      throw new Error(`Invalid player value change date: ${changeDate}`);
    }

    const currentChangeDate = dependencies.getCurrentChangeDate();
    if (changeDate !== currentChangeDate) {
      logInfo('Skipping player values capture outside its scheduled date', {
        changeDate,
        currentChangeDate,
      });
      return { count: 0 };
    }

    const [bootstrapData, syncEvent] = await Promise.all([
      dependencies.getBootstrap(),
      dependencies.resolvePlayerSyncEvent(),
    ]);
    if (!syncEvent) {
      throw new Error('No current or next event found for player values');
    }

    if (!Array.isArray(bootstrapData.elements) || bootstrapData.elements.length === 0) {
      throw new Error('No player values returned from FPL API');
    }

    // Get the last value inside this published season only. Element IDs are
    // reused by FPL and must not be compared with prior-season players.
    const seasonFloor = getPlayerValueSeasonFloor(syncEvent.event.deadlineTime);
    const lastStoredValues = await dependencies.findLatestForAllPlayers(seasonFloor, changeDate);
    const lastValueMap = new Map<number, number>();
    lastStoredValues.forEach((pv) => lastValueMap.set(pv.elementId, pv.value));

    // Check if we've already recorded changes for today
    const todaysRecords = await dependencies.findByChangeDate(changeDate);
    const todaysPlayerIds = new Set(todaysRecords.map((pv) => pv.elementId));

    // Find players with price changes that haven't been recorded today
    const playersWithChanges = bootstrapData.elements.filter((player) => {
      if (todaysPlayerIds.has(player.id)) return false;
      const lastValue = lastValueMap.get(player.id);
      return lastValue === undefined || player.now_cost !== lastValue;
    });

    if (playersWithChanges.length === 0 && todaysRecords.length === 0) {
      logInfo('No player price changes detected; preserving database and cache', { changeDate });
      return { count: 0 };
    }

    const teams = await dependencies.loadTeamsBasicInfo();
    const teamsMap = createTeamsMap(teams);

    const playerValues = transformPlayerValuesWithChanges(
      playersWithChanges,
      syncEvent.event.id,
      teamsMap,
      lastValueMap,
      changeDate,
    );

    const result = await dependencies.insertBatch(playerValues);

    const persistedRows =
      playersWithChanges.length > 0
        ? await dependencies.findByChangeDate(changeDate)
        : todaysRecords;
    const persistedById = new Map(persistedRows.map((row) => [row.elementId, row]));
    for (const expected of playerValues) {
      const persisted = persistedById.get(expected.elementId);
      if (
        !persisted ||
        persisted.value !== expected.value ||
        persisted.lastValue !== expected.lastValue ||
        persisted.changeType !== expected.changeType
      ) {
        throw new Error(
          `Player value persistence verification failed for player ${expected.elementId}`,
        );
      }
    }

    const elementsById = new Map(bootstrapData.elements.map((element) => [element.id, element]));
    const expectedCacheRows = enrichStoredRows(persistedRows, elementsById, teamsMap);
    const cachedRows = await dependencies.getCachedValues(changeDate);
    const cacheRepairs = findPlayerValueCacheRepairs(expectedCacheRows, cachedRows);
    // Even when every history field already matches, rewrite one verified
    // positive field before deleting the negative marker. This makes a retry
    // recover when a prior HSET succeeded but its subsequent DEL failed.
    const cacheWrites = cacheRepairs.length > 0 ? cacheRepairs : expectedCacheRows.slice(0, 1);
    if (cacheWrites.length > 0) {
      await dependencies.mergeCachedValues(changeDate, cacheWrites);
    }
    if (cacheRepairs.length > 0) {
      logInfo('Player values cache fields repaired', {
        changeDate,
        count: cacheRepairs.length,
      });
    }

    const hasPersistedPriceChanges = persistedRows.some(
      (row) => row.changeType === 'Rise' || row.changeType === 'Faller',
    );
    if (hasPersistedPriceChanges) {
      await dependencies.enqueuePlayerPrices('cascade', {
        changeDate,
        jobId: `player-prices-${changeDate}-immediate`,
        removeOnSettle: true,
      });
    }

    const insertedPriceChanges = result.inserted.filter(
      (row) => row.changeType === 'Rise' || row.changeType === 'Faller',
    );
    if (insertedPriceChanges.length > 0) {
      try {
        const message = formatPlayerValuesNotification(changeDate, result.inserted);
        await dependencies.notify(message);
      } catch (error) {
        logError('Failed to send player values notification', error, { changeDate });
      }
    }

    logInfo('Daily player values sync completed', {
      eventId: syncEvent.event.id,
      changeDate,
      totalChecked: bootstrapData.elements.length,
      changesDetected: playersWithChanges.length,
      recordsInserted: result.count,
    });

    return { count: result.count };
  };
}

export const syncCurrentPlayerValues = createPlayerValuesSync(defaultDependencies);
