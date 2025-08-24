import { z } from 'zod';

import type { Player, RawFPLElement } from '../types';

// ================================
// Domain Validation Schemas
// ================================

export const PlayerSchema = z.object({
  id: z.number().int().positive('Player ID must be a positive integer'),
  code: z.number().int().positive('Player code must be a positive integer'),
  type: z
    .number()
    .int()
    .min(1)
    .max(4, 'Player type must be between 1-4 (GKP=1, DEF=2, MID=3, FWD=4)'),
  teamId: z.number().int().positive('Team ID must be a positive integer'),
  price: z
    .number()
    .int()
    .min(35, 'Price must be at least 3.5m')
    .max(150, 'Price cannot exceed 15.0m'),
  startPrice: z
    .number()
    .int()
    .min(35, 'Start price must be at least 3.5m')
    .max(150, 'Start price cannot exceed 15.0m'),
  firstName: z.string().min(1, 'First name is required').max(50, 'First name too long'),
  secondName: z.string().min(1, 'Second name is required').max(50, 'Second name too long'),
  webName: z.string().min(1, 'Web name is required').max(30, 'Web name too long'),
});

export const RawFPLElementSchema = z.object({
  id: z.number().int().positive(),
  code: z.number().int().positive(),
  element_type: z.number().int().min(1).max(4),
  team: z.number().int().positive(),
  now_cost: z.number().int().min(35).max(150),
  cost_change_start: z.number().int(),
  first_name: z.string().min(1),
  second_name: z.string().min(1),
  web_name: z.string().min(1),
  status: z.string().optional(),
  selected_by_percent: z.string().optional(),
  total_points: z.number().int().optional(),
  form: z.string().optional(),
  points_per_game: z.string().optional(),
  minutes: z.number().int().min(0).optional(),
  goals_scored: z.number().int().min(0).optional(),
  assists: z.number().int().min(0).optional(),
  clean_sheets: z.number().int().min(0).optional(),
  goals_conceded: z.number().int().min(0).optional(),
  yellow_cards: z.number().int().min(0).optional(),
  red_cards: z.number().int().min(0).optional(),
  saves: z.number().int().min(0).optional(),
  bonus: z.number().int().min(0).optional(),
  bps: z.number().int().optional(),
  transfers_in: z.number().int().min(0).optional(),
  transfers_out: z.number().int().min(0).optional(),
  transfers_in_event: z.number().int().min(0).optional(),
  transfers_out_event: z.number().int().min(0).optional(),
  dreamteam_count: z.number().int().min(0).optional(),
  in_dreamteam: z.boolean().optional(),
  special: z.boolean().optional(),
  squad_number: z.number().int().nullable().optional(),
  chance_of_playing_this_round: z.number().int().min(0).max(100).nullable().optional(),
  chance_of_playing_next_round: z.number().int().min(0).max(100).nullable().optional(),
  news: z.string().optional(),
  news_added: z.string().nullable().optional(),
});

// ================================
// Domain Business Logic
// ================================

/**
 * Player position type mapping from element_type
 */
export type PlayerPosition = 'GKP' | 'DEF' | 'MID' | 'FWD';

/**
 * Get player position from element_type
 */
export function getPlayerPosition(elementType: number): PlayerPosition {
  switch (elementType) {
    case 1:
      return 'GKP';
    case 2:
      return 'DEF';
    case 3:
      return 'MID';
    case 4:
      return 'FWD';
    default:
      throw new Error(`Invalid element type: ${elementType}`);
  }
}

/**
 * Check if player is available for selection (not injured/suspended)
 */
export function isPlayerAvailable(player: {
  status?: string;
  chanceOfPlayingThisRound?: number | null;
}): boolean {
  if (player.status === 'u' || player.status === 's') {
    return false; // unavailable or suspended
  }

  if (player.chanceOfPlayingThisRound !== null && player.chanceOfPlayingThisRound !== undefined) {
    return player.chanceOfPlayingThisRound > 0;
  }

  return true; // assume available if no status info
}

/**
 * Check if player is a premium pick (high price)
 */
export function isPremiumPlayer(player: Player): boolean {
  return player.price >= 95; // 9.5m or more
}

/**
 * Check if player is budget-friendly
 */
export function isBudgetPlayer(player: Player): boolean {
  return player.price <= 60; // 6.0m or less
}

/**
 * Get player value based on price and form
 */
export function getPlayerValueRating(
  player: Player & { totalPoints?: number; form?: string },
): 'excellent' | 'good' | 'average' | 'poor' | 'unknown' {
  if (!player.totalPoints || !player.form) return 'unknown';

  const pointsPerMillion = player.totalPoints / (player.price / 10);
  const formValue = parseFloat(player.form) || 0;

  if (pointsPerMillion >= 15 && formValue >= 4) return 'excellent';
  if (pointsPerMillion >= 10 && formValue >= 3) return 'good';
  if (pointsPerMillion >= 5 && formValue >= 1) return 'average';
  return 'poor';
}

/**
 * Check if player is differential (low ownership)
 */
export function isDifferentialPlayer(player: { selectedByPercent?: string }): boolean {
  if (!player.selectedByPercent) return false;

  const ownership = parseFloat(player.selectedByPercent);
  return ownership < 5.0; // Less than 5% ownership
}

/**
 * Check if player is highly owned (template player)
 */
export function isTemplatePlayer(player: { selectedByPercent?: string }): boolean {
  if (!player.selectedByPercent) return false;

  const ownership = parseFloat(player.selectedByPercent);
  return ownership > 20.0; // More than 20% ownership
}

/**
 * Get player form rating
 */
export function getFormRating(player: {
  form?: string;
}): 'excellent' | 'good' | 'average' | 'poor' | 'unknown' {
  if (!player.form) return 'unknown';

  const form = parseFloat(player.form);

  if (form >= 5.0) return 'excellent';
  if (form >= 3.5) return 'good';
  if (form >= 2.0) return 'average';
  return 'poor';
}

/**
 * Check if player has injury concerns
 */
export function hasInjuryConcerns(player: {
  status?: string;
  chanceOfPlayingThisRound?: number | null;
  news?: string;
}): boolean {
  if (player.status === 'i' || player.status === 'd') {
    return true; // injured or doubtful
  }

  if (player.chanceOfPlayingThisRound !== null && player.chanceOfPlayingThisRound !== undefined) {
    return player.chanceOfPlayingThisRound < 75;
  }

  if (player.news) {
    const injuryKeywords = ['injury', 'injured', 'doubt', 'fitness', 'strain', 'knock'];
    return injuryKeywords.some((keyword) => player.news!.toLowerCase().includes(keyword));
  }

  return false;
}

/**
 * Calculate player price change since start of season
 */
export function getPriceChange(player: Player): number {
  return player.price - player.startPrice;
}

/**
 * Get price change direction
 */
export function getPriceChangeDirection(player: Player): 'rise' | 'fall' | 'stable' {
  const change = getPriceChange(player);
  if (change > 0) return 'rise';
  if (change < 0) return 'fall';
  return 'stable';
}

/**
 * Filter players by position
 */
export function filterPlayersByPosition(players: Player[], position: PlayerPosition): Player[] {
  const positionType = getPositionType(position);
  return players.filter((player) => player.type === positionType);
}

/**
 * Get element_type from position
 */
export function getPositionType(position: PlayerPosition): number {
  switch (position) {
    case 'GKP':
      return 1;
    case 'DEF':
      return 2;
    case 'MID':
      return 3;
    case 'FWD':
      return 4;
    default:
      throw new Error(`Invalid position: ${position}`);
  }
}

/**
 * Filter players by team
 */
export function filterPlayersByTeam(players: Player[], teamId: number): Player[] {
  return players.filter((player) => player.teamId === teamId);
}

/**
 * Filter players by price range
 */
export function filterPlayersByPriceRange(
  players: Player[],
  minPrice: number,
  maxPrice: number,
): Player[] {
  return players.filter((player) => player.price >= minPrice && player.price <= maxPrice);
}

/**
 * Get top players by position and price
 */
export function getTopPlayersByPosition(
  players: Player[],
  position: PlayerPosition,
  limit: number = 10,
): Player[] {
  return filterPlayersByPosition(players, position)
    .sort((a, b) => b.price - a.price) // Sort by price descending
    .slice(0, limit);
}

/**
 * Get budget players by position
 */
export function getBudgetPlayersByPosition(
  players: Player[],
  position: PlayerPosition,
  limit: number = 10,
): Player[] {
  return filterPlayersByPosition(players, position)
    .filter(isBudgetPlayer)
    .sort((a, b) => a.price - b.price) // Sort by price ascending
    .slice(0, limit);
}

// ================================
// Validation Functions
// ================================

/**
 * Validate a player object against the domain schema
 */
export function validatePlayer(player: unknown): Player {
  return PlayerSchema.parse(player);
}

/**
 * Validate raw FPL element data
 */
export function validateRawFPLElement(rawElement: unknown): RawFPLElement {
  return RawFPLElementSchema.parse(rawElement);
}

/**
 * Validate array of players
 */
export function validatePlayers(players: unknown[]): Player[] {
  return players.map(validatePlayer);
}

/**
 * Check if player data has been recently updated (within last hour)
 */
export function isRecentlyUpdated(player: { updatedAt?: Date | string }): boolean {
  if (!player.updatedAt) return false;

  const updatedAt =
    player.updatedAt instanceof Date ? player.updatedAt : new Date(player.updatedAt);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  return updatedAt > hourAgo;
}

// ================================
// Export type inference helpers
// ================================

export type ValidatedPlayer = z.infer<typeof PlayerSchema>;
export type ValidatedRawFPLElement = z.infer<typeof RawFPLElementSchema>;
