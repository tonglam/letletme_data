import { validatePlayer, validateRawFPLElement } from '../domain/players';
import { logError, logInfo } from '../utils/logger';

import type { Player } from '../types';

// ================================
// Data Transformation Functions
// ================================

/**
 * Transform FPL API element to our domain Player
 * Includes validation and error handling
 */
export function transformPlayer(rawElement: unknown): Player {
  try {
    // Validate raw data first
    const validatedRawElement = validateRawFPLElement(rawElement);

    // Transform to domain model
    const player: Player = {
      id: validatedRawElement.id,
      code: validatedRawElement.code,
      type: validatedRawElement.element_type,
      teamId: validatedRawElement.team,
      price: validatedRawElement.now_cost,
      startPrice: validatedRawElement.now_cost - validatedRawElement.cost_change_start,
      firstName: validatedRawElement.first_name,
      secondName: validatedRawElement.second_name,
      webName: validatedRawElement.web_name,
    };

    // Validate the transformed player
    return validatePlayer(player);
  } catch (error) {
    logError('Failed to transform player', error, { rawElement });
    throw new Error(
      `Failed to transform player data: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Transform array of players with error handling for individual items
 * Returns only successfully transformed players and logs errors for failed ones
 */
export function transformPlayers(rawElements: unknown[]): Player[] {
  const transformedPlayers: Player[] = [];
  const errors: Array<{ index: number; error: Error }> = [];

  for (let i = 0; i < rawElements.length; i++) {
    try {
      const transformedPlayer = transformPlayer(rawElements[i]);
      transformedPlayers.push(transformedPlayer);
    } catch (error) {
      errors.push({
        index: i,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  if (errors.length > 0) {
    logError('Some players failed to transform', new Error('Transform errors'), {
      totalCount: rawElements.length,
      successCount: transformedPlayers.length,
      errorCount: errors.length,
      errors: errors.map((e) => ({ index: e.index, message: e.error.message })),
    });
  }

  logInfo('Players transformation completed', {
    totalCount: rawElements.length,
    successCount: transformedPlayers.length,
    errorCount: errors.length,
  });

  return transformedPlayers;
}

/**
 * Transform players with strict validation (throws on any error)
 * Use this when you need all players to be valid or fail completely
 */
export function transformPlayersStrict(rawElements: unknown[]): Player[] {
  return rawElements.map((rawElement, index) => {
    try {
      return transformPlayer(rawElement);
    } catch (error) {
      throw new Error(
        `Failed to transform player at index ${index}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  });
}

/**
 * Transform single player without throwing errors
 * Returns null if transformation fails
 */
export function safeTransformPlayer(rawElement: unknown): Player | null {
  try {
    return transformPlayer(rawElement);
  } catch (error) {
    logError('Safe transform player failed', error, { rawElement });
    return null;
  }
}

// ================================
// Enhanced Transformation with Additional Data
// ================================

/**
 * Extended player data for enhanced domain operations
 */
export interface EnhancedPlayer extends Player {
  status?: string;
  selectedByPercent?: string;
  totalPoints?: number;
  form?: string;
  pointsPerGame?: string;
  minutes?: number;
  goalScored?: number;
  assists?: number;
  cleanSheets?: number;
  goalsConceded?: number;
  yellowCards?: number;
  redCards?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
  transfersIn?: number;
  transfersOut?: number;
  transfersInEvent?: number;
  transfersOutEvent?: number;
  dreamteamCount?: number;
  inDreamteam?: boolean;
  special?: boolean;
  squadNumber?: number | null;
  chanceOfPlayingThisRound?: number | null;
  chanceOfPlayingNextRound?: number | null;
  news?: string;
  newsAdded?: string | null;
}

/**
 * Transform player with extended data for analytics and domain operations
 */
export function transformEnhancedPlayer(rawElement: unknown): EnhancedPlayer {
  const basePlayer = transformPlayer(rawElement);
  const validatedRawElement = validateRawFPLElement(rawElement);

  return {
    ...basePlayer,
    status: validatedRawElement.status,
    selectedByPercent: validatedRawElement.selected_by_percent,
    totalPoints: validatedRawElement.total_points,
    form: validatedRawElement.form,
    pointsPerGame: validatedRawElement.points_per_game,
    minutes: validatedRawElement.minutes,
    goalScored: validatedRawElement.goals_scored,
    assists: validatedRawElement.assists,
    cleanSheets: validatedRawElement.clean_sheets,
    goalsConceded: validatedRawElement.goals_conceded,
    yellowCards: validatedRawElement.yellow_cards,
    redCards: validatedRawElement.red_cards,
    saves: validatedRawElement.saves,
    bonus: validatedRawElement.bonus,
    bps: validatedRawElement.bps,
    transfersIn: validatedRawElement.transfers_in,
    transfersOut: validatedRawElement.transfers_out,
    transfersInEvent: validatedRawElement.transfers_in_event,
    transfersOutEvent: validatedRawElement.transfers_out_event,
    dreamteamCount: validatedRawElement.dreamteam_count,
    inDreamteam: validatedRawElement.in_dreamteam,
    special: validatedRawElement.special,
    squadNumber: validatedRawElement.squad_number,
    chanceOfPlayingThisRound: validatedRawElement.chance_of_playing_this_round,
    chanceOfPlayingNextRound: validatedRawElement.chance_of_playing_next_round,
    news: validatedRawElement.news,
    newsAdded: validatedRawElement.news_added,
  };
}

/**
 * Transform array of players with enhanced data
 */
export function transformEnhancedPlayers(rawElements: unknown[]): EnhancedPlayer[] {
  const transformedPlayers: EnhancedPlayer[] = [];
  const errors: Array<{ index: number; error: Error }> = [];

  for (let i = 0; i < rawElements.length; i++) {
    try {
      const transformedPlayer = transformEnhancedPlayer(rawElements[i]);
      transformedPlayers.push(transformedPlayer);
    } catch (error) {
      errors.push({
        index: i,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  if (errors.length > 0) {
    logError('Some enhanced players failed to transform', new Error('Transform errors'), {
      totalCount: rawElements.length,
      successCount: transformedPlayers.length,
      errorCount: errors.length,
    });
  }

  logInfo('Enhanced players transformation completed', {
    totalCount: rawElements.length,
    successCount: transformedPlayers.length,
    errorCount: errors.length,
  });

  return transformedPlayers;
}
