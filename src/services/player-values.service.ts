import { playerValuesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { playerValuesRepository } from '../repositories/player-values';
import { createTeamsMap } from '../transformers/player-values';
import { logInfo } from '../utils/logger';
import { loadTeamsBasicInfo } from '../utils/teams';

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
export async function syncCurrentPlayerValues(): Promise<{ count: number }> {
  logInfo('Starting daily player values sync');

  const bootstrapData = await fplClient.getBootstrap();
  const currentEvent = bootstrapData.events.find((event) => event.is_current);
  if (!currentEvent) {
    throw new Error('No current event found in FPL bootstrap data');
  }

  if (!Array.isArray(bootstrapData.elements) || bootstrapData.elements.length === 0) {
    throw new Error('No player values returned from FPL API');
  }

  // Generate today's date in YYYYMMDD format (e.g., "20260118")
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');

  // Get last stored value for each player
  const lastStoredValues = await playerValuesRepository.findLatestForAllPlayers();
  const lastValueMap = new Map<number, number>();
  lastStoredValues.forEach((pv) => lastValueMap.set(pv.elementId, pv.value));

  // Check if we've already recorded changes for today
  const todaysRecords = await playerValuesRepository.findByChangeDate(today);
  const todaysPlayerIds = new Set(todaysRecords.map((pv) => pv.elementId));

  const teams = await loadTeamsBasicInfo();
  const teamsMap = createTeamsMap(teams);

  // Find players with price changes that haven't been recorded today
  const playersWithChanges = bootstrapData.elements.filter((player) => {
    if (todaysPlayerIds.has(player.id)) return false;
    const lastValue = lastValueMap.get(player.id) || 0;
    return player.now_cost !== lastValue;
  });

  if (playersWithChanges.length === 0) {
    logInfo('No player price changes detected today');
    return { count: 0 };
  }

  const { transformPlayerValuesWithChanges } = await import('../transformers/player-values');
  const playerValues = transformPlayerValuesWithChanges(
    playersWithChanges,
    currentEvent.id,
    teamsMap,
    lastValueMap,
    today,
  );

  const result = await playerValuesRepository.insertBatch(playerValues);

  if (result.count > 0) {
    await playerValuesCache.setByDate(today, playerValues);
    logInfo('Player values cache updated for date', { changeDate: today, count: result.count });
  }

  logInfo('Daily player values sync completed', {
    eventId: currentEvent.id,
    changeDate: today,
    totalChecked: bootstrapData.elements.length,
    changesDetected: playersWithChanges.length,
    recordsInserted: result.count,
  });

  return result;
}
