import { z } from 'zod';

import type {
  EventId,
  PlayerId,
  PlayerTypeID,
  PlayerTypeName,
  TeamId,
  ValueChangeType,
} from '../types/base.type';

// ================================
// Domain Types
// ================================

export interface PlayerValue {
  readonly elementId: PlayerId;
  readonly webName: string;
  readonly elementType: PlayerTypeID;
  readonly elementTypeName: PlayerTypeName;
  readonly eventId: EventId;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
}

export type PlayerValues = readonly PlayerValue[];

export type RawPlayerValue = Omit<
  PlayerValue,
  'webName' | 'elementTypeName' | 'teamName' | 'teamShortName'
>;
export type RawPlayerValues = readonly RawPlayerValue[];

// ================================
// Domain Validation Schemas
// ================================

export const PlayerValueSchema = z.object({
  elementId: z.number().int().positive('Element ID must be a positive integer'),
  webName: z.string().min(1, 'Web name is required').max(30, 'Web name too long'),
  elementType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)], {
    errorMap: () => ({ message: 'Element type must be 1-4 (GKP=1, DEF=2, MID=3, FWD=4)' }),
  }),
  elementTypeName: z.enum(['GKP', 'DEF', 'MID', 'FWD'], {
    errorMap: () => ({ message: 'Element type name must be GKP, DEF, MID, or FWD' }),
  }),
  eventId: z.number().int().positive('Event ID must be a positive integer'),
  teamId: z.number().int().positive('Team ID must be a positive integer'),
  teamName: z.string().min(1, 'Team name is required').max(50, 'Team name too long'),
  teamShortName: z
    .string()
    .min(1, 'Team short name is required')
    .max(10, 'Team short name too long'),
  value: z
    .number()
    .int()
    .min(35, 'Value must be at least 3.5m')
    .max(150, 'Value cannot exceed 15.0m'),
  changeDate: z.string().min(1, 'Change date is required'),
  changeType: z.enum(['increase', 'decrease', 'stable', 'unknown'], {
    errorMap: () => ({ message: 'Change type must be increase, decrease, stable, or unknown' }),
  }),
  lastValue: z
    .number()
    .int()
    .min(35, 'Last value must be at least 3.5m')
    .max(150, 'Last value cannot exceed 15.0m'),
});

export const RawPlayerValueSchema = PlayerValueSchema.omit({
  webName: true,
  elementTypeName: true,
  teamName: true,
  teamShortName: true,
});

// ================================
// Domain Business Logic
// ================================

/**
 * Calculate value change amount
 */
export function getValueChangeAmount(playerValue: PlayerValue): number {
  return playerValue.value - playerValue.lastValue;
}

/**
 * Calculate value change percentage
 */
export function getValueChangePercentage(playerValue: PlayerValue): number {
  if (playerValue.lastValue <= 0) return 0;
  return ((playerValue.value - playerValue.lastValue) / playerValue.lastValue) * 100;
}

/**
 * Determine value change type based on current and last value
 */
export function determineValueChangeType(currentValue: number, lastValue: number): ValueChangeType {
  if (currentValue > lastValue) return 'increase';
  if (currentValue < lastValue) return 'decrease';
  return 'stable';
}

/**
 * Check if player has significant value change (>= 1 million)
 */
export function hasSignificantValueChange(playerValue: PlayerValue): boolean {
  const changeAmount = Math.abs(getValueChangeAmount(playerValue));
  return changeAmount >= 10; // 1.0m in FPL units (10 = 1.0m)
}

/**
 * Get value in millions (display format)
 */
export function getValueInMillions(value: number): number {
  return value / 10;
}

/**
 * Check if player is rising in value
 */
export function isRisingInValue(playerValue: PlayerValue): boolean {
  return playerValue.changeType === 'increase';
}

/**
 * Check if player is falling in value
 */
export function isFallingInValue(playerValue: PlayerValue): boolean {
  return playerValue.changeType === 'decrease';
}

/**
 * Get players with most value increase
 */
export function getTopValueRisers(playerValues: PlayerValues, limit: number = 10): PlayerValues {
  if (limit <= 0) return [];
  return [...playerValues]
    .filter((pv) => pv.changeType === 'increase')
    .sort((a, b) => getValueChangeAmount(b) - getValueChangeAmount(a))
    .slice(0, limit);
}

/**
 * Get players with most value decrease
 */
export function getTopValueFallers(playerValues: PlayerValues, limit: number = 10): PlayerValues {
  if (limit <= 0) return [];
  return [...playerValues]
    .filter((pv) => pv.changeType === 'decrease')
    .sort((a, b) => getValueChangeAmount(a) - getValueChangeAmount(b))
    .slice(0, limit);
}

/**
 * Filter player values by position
 */
export function filterPlayerValuesByPosition(
  playerValues: PlayerValues,
  elementType: PlayerTypeID,
): PlayerValues {
  return playerValues.filter((pv) => pv.elementType === elementType);
}

/**
 * Filter player values by team
 */
export function filterPlayerValuesByTeam(playerValues: PlayerValues, teamId: TeamId): PlayerValues {
  return playerValues.filter((pv) => pv.teamId === teamId);
}

/**
 * Filter player values by change type
 */
export function filterPlayerValuesByChangeType(
  playerValues: PlayerValues,
  changeType: ValueChangeType,
): PlayerValues {
  return playerValues.filter((pv) => pv.changeType === changeType);
}

/**
 * Sort player values by value (ascending)
 */
export function sortPlayerValuesByValue(playerValues: PlayerValues): PlayerValues {
  return [...playerValues].sort((a, b) => a.value - b.value);
}

/**
 * Sort player values by change amount (descending)
 */
export function sortPlayerValuesByChangeAmount(playerValues: PlayerValues): PlayerValues {
  return [...playerValues].sort((a, b) => getValueChangeAmount(b) - getValueChangeAmount(a));
}

/**
 * Get value change statistics for all players
 */
export function getValueChangeStats(playerValues: PlayerValues): {
  totalRisers: number;
  totalFallers: number;
  totalStable: number;
  averageValue: number;
  totalValueChange: number;
} {
  let totalRisers = 0;
  let totalFallers = 0;
  let totalStable = 0;
  let totalValue = 0;
  let totalValueChange = 0;

  for (const pv of playerValues) {
    switch (pv.changeType) {
      case 'increase':
        totalRisers++;
        break;
      case 'decrease':
        totalFallers++;
        break;
      case 'stable':
        totalStable++;
        break;
    }
    totalValue += pv.value;
    totalValueChange += getValueChangeAmount(pv);
  }

  return {
    totalRisers,
    totalFallers,
    totalStable,
    averageValue: playerValues.length > 0 ? totalValue / playerValues.length : 0,
    totalValueChange,
  };
}

// ================================
// Validation Functions
// ================================

/**
 * Validate a player value object against the domain schema
 */
export function validatePlayerValue(playerValue: unknown): PlayerValue {
  return PlayerValueSchema.parse(playerValue);
}

/**
 * Validate raw player value data
 */
export function validateRawPlayerValue(rawPlayerValue: unknown): RawPlayerValue {
  return RawPlayerValueSchema.parse(rawPlayerValue);
}

/**
 * Validate array of player values
 */
export function validatePlayerValues(playerValues: unknown[]): PlayerValues {
  return playerValues.map(validatePlayerValue);
}

/**
 * Check if player value data has been recently updated (within last hour)
 */
export function isRecentlyUpdated(playerValue: { updatedAt?: Date | string }): boolean {
  if (!playerValue.updatedAt) return false;

  const updatedAt =
    playerValue.updatedAt instanceof Date ? playerValue.updatedAt : new Date(playerValue.updatedAt);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  return updatedAt > hourAgo;
}

// ================================
// Export type inference helpers
// ================================

export type ValidatedPlayerValue = z.infer<typeof PlayerValueSchema>;
export type ValidatedRawPlayerValue = z.infer<typeof RawPlayerValueSchema>;
