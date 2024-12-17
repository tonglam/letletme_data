import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';
import { player_value_change_type_enum } from '../constants/enum';

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
export const PlayerValueResponseSchema = z.object({
  id: z.number(),
  element_type: z.number(),
  now_cost: z.number(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
export const PlayerValueSchema = z.object({
  elementId: z.number(),
  elementType: z.number(),
  eventId: z.number(),
  value: z.number(),
  lastValue: z.number(),
  changeDate: z.string(),
  changeType: z.enum(Object.values(player_value_change_type_enum) as [string, ...string[]]),
});

export const PlayerValuesSchema = z.array(PlayerValueSchema);
export const PlayerValuesResponseSchema = z.array(PlayerValueResponseSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type PlayerValueResponse = z.infer<typeof PlayerValueResponseSchema>;
export type PlayerValuesResponse = z.infer<typeof PlayerValuesResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type PlayerValue = z.infer<typeof PlayerValueSchema>;
export type PlayerValues = z.infer<typeof PlayerValuesSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate PlayerValueResponse to PlayerValue
 */
export const toDomainPlayerValue = (
  raw: PlayerValueResponse,
  eventId: number,
  lastValue: number,
  changeDate: string,
  changeType: keyof typeof player_value_change_type_enum,
): Either<string, PlayerValue> => {
  try {
    const result = PlayerValueSchema.safeParse({
      elementId: raw.id,
      elementType: raw.element_type,
      eventId,
      value: raw.now_cost,
      lastValue,
      changeDate,
      changeType: player_value_change_type_enum[changeType],
    });

    return result.success
      ? right(result.data)
      : left(`Invalid player value domain model: ${result.error.message}`);
  } catch (error) {
    return left(
      `Failed to transform player value data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
