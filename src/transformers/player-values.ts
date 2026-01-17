import type { PlayerValue, RawPlayerValue } from '../domain/player-values';
import {
  determineValueChangeType,
  validatePlayerValue,
  validateRawPlayerValue,
} from '../domain/player-values';
import type { RawFPLElement } from '../types';
import type { EventId, ValueChangeType } from '../types/base.type';
import { ELEMENT_TYPE_MAP } from '../types/base.type';
import { logError, logInfo } from '../utils/logger';

// ================================
// Data Transformation Functions
// ================================

/**
 * Transform FPL API element to PlayerValue for a specific event
 * Includes validation and error handling
 */
export function transformPlayerValue(
  rawElement: RawFPLElement,
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
  previousValuesMap?: Map<number, number>,
  changeDate?: string,
): PlayerValue {
  try {
    // Get team info from map
    const teamInfo = teamsMap.get(rawElement.team);
    if (!teamInfo) {
      throw new Error(`Team not found for ID: ${rawElement.team}`);
    }

    // Get previous value for comparison
    const lastValue = previousValuesMap?.get(rawElement.id) || rawElement.now_cost;
    const currentValue = rawElement.now_cost;

    // Determine change type
    const changeType = determineValueChangeType(currentValue, lastValue);

    // Use current date if no change date provided
    const effectiveChangeDate = changeDate || new Date().toISOString();

    // Transform to domain model
    const playerValue: PlayerValue = {
      elementId: rawElement.id,
      webName: rawElement.web_name,
      elementType: rawElement.element_type as 1 | 2 | 3 | 4,
      elementTypeName: ELEMENT_TYPE_MAP[rawElement.element_type as 1 | 2 | 3 | 4],
      eventId,
      teamId: rawElement.team,
      teamName: teamInfo.name,
      teamShortName: teamInfo.shortName,
      value: currentValue,
      changeDate: effectiveChangeDate,
      changeType,
      lastValue,
    };

    // Validate the transformed player value
    return validatePlayerValue(playerValue);
  } catch (error) {
    logError('Failed to transform player value', error, { rawElement, eventId });
    throw new Error(
      `Failed to transform player value data: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Transform raw player value data (without computed fields)
 */
export function transformRawPlayerValue(
  rawElement: RawFPLElement,
  eventId: EventId,
  lastValue?: number,
  changeDate?: string,
): RawPlayerValue {
  try {
    const currentValue = rawElement.now_cost;
    const effectiveLastValue = lastValue || currentValue;
    const changeType = determineValueChangeType(currentValue, effectiveLastValue);
    const effectiveChangeDate = changeDate || new Date().toISOString();

    const rawPlayerValue: RawPlayerValue = {
      elementId: rawElement.id,
      elementType: rawElement.element_type as 1 | 2 | 3 | 4,
      eventId,
      teamId: rawElement.team,
      value: currentValue,
      changeDate: effectiveChangeDate,
      changeType,
      lastValue: effectiveLastValue,
    };

    return validateRawPlayerValue(rawPlayerValue);
  } catch (error) {
    logError('Failed to transform raw player value', error, { rawElement, eventId });
    throw new Error(
      `Failed to transform raw player value data: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Transform array of player values with error handling for individual items
 * Returns only successfully transformed player values and logs errors for failed ones
 */
export function transformPlayerValues(
  rawElements: RawFPLElement[],
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
  previousValuesMap?: Map<number, number>,
  changeDate?: string,
): PlayerValue[] {
  const transformedPlayerValues: PlayerValue[] = [];
  const errors: Array<{ index: number; error: Error }> = [];

  for (let i = 0; i < rawElements.length; i++) {
    try {
      const transformedPlayerValue = transformPlayerValue(
        rawElements[i],
        eventId,
        teamsMap,
        previousValuesMap,
        changeDate,
      );
      transformedPlayerValues.push(transformedPlayerValue);
    } catch (error) {
      errors.push({
        index: i,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  if (errors.length > 0) {
    logError('Some player values failed to transform', new Error('Transform errors'), {
      totalCount: rawElements.length,
      successCount: transformedPlayerValues.length,
      errorCount: errors.length,
      eventId,
      errors: errors.map((e) => ({ index: e.index, message: e.error.message })),
    });
  }

  logInfo('Player values transformation completed', {
    totalCount: rawElements.length,
    successCount: transformedPlayerValues.length,
    errorCount: errors.length,
    eventId,
  });

  return transformedPlayerValues;
}

/**
 * Transform player values with strict validation (throws on any error)
 * Use this when you need all player values to be valid or fail completely
 */
export function transformPlayerValuesStrict(
  rawElements: RawFPLElement[],
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
  previousValuesMap?: Map<number, number>,
  changeDate?: string,
): PlayerValue[] {
  return rawElements.map((rawElement, index) => {
    try {
      return transformPlayerValue(rawElement, eventId, teamsMap, previousValuesMap, changeDate);
    } catch (error) {
      throw new Error(
        `Failed to transform player value at index ${index}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  });
}

/**
 * Transform single player value without throwing errors
 * Returns null if transformation fails
 */
export function safeTransformPlayerValue(
  rawElement: RawFPLElement,
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
  previousValuesMap?: Map<number, number>,
  changeDate?: string,
): PlayerValue | null {
  try {
    return transformPlayerValue(rawElement, eventId, teamsMap, previousValuesMap, changeDate);
  } catch (error) {
    logError('Safe transform player value failed', error, { rawElement, eventId });
    return null;
  }
}

// ================================
// Helper Functions
// ================================

/**
 * Create teams map from array of team data for efficient lookups during transformation
 */
export function createTeamsMap(
  teams: Array<{ id: number; name: string; shortName: string }>,
): Map<number, { name: string; shortName: string }> {
  const teamsMap = new Map<number, { name: string; shortName: string }>();

  for (const team of teams) {
    teamsMap.set(team.id, {
      name: team.name,
      shortName: team.shortName,
    });
  }

  return teamsMap;
}

/**
 * Create previous values map from existing player values for efficient lookups
 */
export function createPreviousValuesMap(
  previousPlayerValues: Array<{ elementId: number; value: number }>,
): Map<number, number> {
  const valuesMap = new Map<number, number>();

  for (const pv of previousPlayerValues) {
    valuesMap.set(pv.elementId, pv.value);
  }

  return valuesMap;
}

/**
 * Transform current gameweek player values from FPL bootstrap response
 */
export function transformCurrentGameweekPlayerValues(
  fplBootstrapResponse: {
    elements: RawFPLElement[];
    events: Array<{ id: number; is_current: boolean }>;
    teams: Array<{ id: number; name: string; short_name: string }>;
  },
  previousValuesMap?: Map<number, number>,
  changeDate?: string,
): PlayerValue[] {
  const currentEvent = fplBootstrapResponse.events.find((event) => event.is_current);
  if (!currentEvent) {
    throw new Error('No current event found in FPL bootstrap response');
  }

  const teamsMap = createTeamsMap(
    fplBootstrapResponse.teams.map((team) => ({
      id: team.id,
      name: team.name,
      shortName: team.short_name,
    })),
  );

  return transformPlayerValues(
    fplBootstrapResponse.elements,
    currentEvent.id,
    teamsMap,
    previousValuesMap,
    changeDate,
  );
}

/**
 * Extract unique player IDs from transformed player values
 */
export function extractPlayerIds(playerValues: PlayerValue[]): number[] {
  return [...new Set(playerValues.map((pv) => pv.elementId))];
}

/**
 * Group player values by position type
 */
export function groupPlayerValuesByPosition(
  playerValues: PlayerValue[],
): Record<string, PlayerValue[]> {
  const grouped: Record<string, PlayerValue[]> = {
    GKP: [],
    DEF: [],
    MID: [],
    FWD: [],
  };

  for (const pv of playerValues) {
    grouped[pv.elementTypeName].push(pv);
  }

  return grouped;
}

/**
 * Group player values by team
 */
export function groupPlayerValuesByTeam(
  playerValues: PlayerValue[],
): Record<number, PlayerValue[]> {
  const grouped: Record<number, PlayerValue[]> = {};

  for (const pv of playerValues) {
    if (!grouped[pv.teamId]) {
      grouped[pv.teamId] = [];
    }
    grouped[pv.teamId].push(pv);
  }

  return grouped;
}

/**
 * Get change type based on price comparison (matching Java implementation)
 */
function getChangeType(currentValue: number, lastValue: number): 'Start' | 'Rise' | 'Faller' {
  if (lastValue === 0) {
    return 'Start'; // First time recording this player
  }

  return currentValue > lastValue ? 'Rise' : 'Faller';
}

/**
 * Transform players with price changes to PlayerValue objects (Daily approach)
 * Only processes players whose prices have actually changed from their last stored values
 */
export function transformPlayerValuesWithChanges(
  changedPlayers: RawFPLElement[],
  eventId: EventId,
  teamsMap: Map<number, { name: string; shortName: string }>,
  lastValueMap: Map<number, number>,
  changeDate: string,
): PlayerValue[] {
  const results: PlayerValue[] = [];
  let successCount = 0;
  let errorCount = 0;

  for (const player of changedPlayers) {
    try {
      // Get team information
      const team = teamsMap.get(player.team);
      if (!team) {
        logError('Team not found for player', { playerId: player.id, teamId: player.team });
        errorCount++;
        continue;
      }

      // Get last known value for this player
      const lastValue = lastValueMap.get(player.id) || 0;
      const currentValue = player.now_cost;

      // Determine change type based on price comparison
      const changeType = getChangeType(currentValue, lastValue);

      const playerValue: PlayerValue = {
        eventId,
        elementId: player.id,
        webName: player.web_name,
        elementType: player.element_type as 1 | 2 | 3 | 4,
        elementTypeName: ELEMENT_TYPE_MAP[player.element_type as 1 | 2 | 3 | 4],
        teamId: player.team,
        teamName: team.name,
        teamShortName: team.shortName,
        value: currentValue,
        lastValue,
        changeDate,
        changeType,
      };

      results.push(playerValue);
      successCount++;
    } catch (error) {
      logError('Failed to transform player value', error, {
        playerId: player.id,
        playerName: player.web_name,
      });
      errorCount++;
    }
  }

  logInfo('Player values transformation completed', {
    totalInput: changedPlayers.length,
    successfulOutput: successCount,
    skippedCount: errorCount,
  });

  return results;
}

/**
 * Group player values by change type
 */
export function groupPlayerValuesByChangeType(
  playerValues: PlayerValue[],
): Record<ValueChangeType, PlayerValue[]> {
  const grouped: Record<ValueChangeType, PlayerValue[]> = {
    Start: [],
    Rise: [],
    Faller: [],
  };

  for (const pv of playerValues) {
    grouped[pv.changeType].push(pv);
  }

  return grouped;
}

/**
 * Calculate value change statistics from player values array
 */
export function calculateValueChangeStats(playerValues: PlayerValue[]): {
  totalPlayers: number;
  risers: number;
  fallers: number;
  stable: number;
  totalValueIncrease: number;
  totalValueDecrease: number;
  averageValue: number;
} {
  let risers = 0;
  let fallers = 0;
  let stable = 0;
  let totalValueIncrease = 0;
  let totalValueDecrease = 0;
  let totalValue = 0;

  for (const pv of playerValues) {
    const changeAmount = pv.value - pv.lastValue;

    switch (pv.changeType) {
      case 'Rise':
        risers++;
        totalValueIncrease += changeAmount;
        break;
      case 'Faller':
        fallers++;
        totalValueDecrease += Math.abs(changeAmount);
        break;
      case 'Start':
        stable++;
        break;
    }

    totalValue += pv.value;
  }

  return {
    totalPlayers: playerValues.length,
    risers,
    fallers,
    stable,
    totalValueIncrease,
    totalValueDecrease,
    averageValue: playerValues.length > 0 ? totalValue / playerValues.length : 0,
  };
}
