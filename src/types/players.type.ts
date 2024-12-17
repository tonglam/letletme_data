import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
export const PlayerResponseSchema = z.object({
  id: z.number(),
  code: z.number(),
  now_cost: z.number(),
  cost_change_start: z.number(),
  element_type: z.number(),
  first_name: z.string().nullable(),
  second_name: z.string().nullable(),
  web_name: z.string(),
  team: z.number(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
export const PlayerSchema = z.object({
  element: z.number(),
  elementCode: z.number(),
  price: z.number(),
  startPrice: z.number(),
  elementType: z.number(),
  firstName: z.string().nullable(),
  secondName: z.string().nullable(),
  webName: z.string(),
  teamId: z.number(),
});

export const PlayersSchema = z.array(PlayerSchema);
export const PlayersResponseSchema = z.array(PlayerResponseSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type PlayerResponse = z.infer<typeof PlayerResponseSchema>;
export type PlayersResponse = z.infer<typeof PlayersResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type Player = z.infer<typeof PlayerSchema>;
export type Players = z.infer<typeof PlayersSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate PlayerResponse to Player
 */
export const toDomainPlayer = (raw: PlayerResponse): Either<string, Player> => {
  try {
    const result = PlayerSchema.safeParse({
      element: raw.id,
      elementCode: raw.code,
      price: raw.now_cost,
      startPrice: raw.cost_change_start,
      elementType: raw.element_type,
      firstName: raw.first_name,
      secondName: raw.second_name,
      webName: raw.web_name,
      teamId: raw.team,
    });

    return result.success
      ? right(result.data)
      : left(`Invalid player domain model: ${result.error.message}`);
  } catch (error) {
    return left(
      `Failed to transform player data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
