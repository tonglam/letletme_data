import { playerValuesCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import type { PlayerValue } from '../domain/player-values';
import { playerValuesRepository } from '../repositories/player-values';
import { createTeamsMap } from '../transformers/player-values';
import { notifyTwoBots } from '../utils/notify';
import { logInfo } from '../utils/logger';
import { loadTeamsBasicInfo } from '../utils/teams';

function formatPlayerValuesNotification(
  changeDate: string,
  playerValues: readonly PlayerValue[],
): string {
  const formatPrice = (value: number) => `£${(value / 10).toFixed(1)}m`;
  const risers = playerValues
    .filter((pv) => pv.changeType === 'Rise')
    .slice()
    .sort((a, b) => b.value - b.lastValue - (a.value - a.lastValue));
  const fallers = playerValues
    .filter((pv) => pv.changeType === 'Faller')
    .slice()
    .sort((a, b) => a.value - a.lastValue - (b.value - b.lastValue));

  const header = `[player-values] ${changeDate}: +${risers.length} -${fallers.length} (total ${playerValues.length})`;

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
    // Clear cache for today if no changes (in case there was old data)
    await playerValuesCache.clear(today);
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

  // Cache only the player values that changed on this date
  if (result.count > 0) {
    await playerValuesCache.set(today, playerValues);
    logInfo('Player values cache updated', { changeDate: today, count: playerValues.length });

    const message = formatPlayerValuesNotification(today, playerValues);
    await notifyTwoBots(message);
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
