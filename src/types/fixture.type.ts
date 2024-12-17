import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
const FixtureResponseSchema = z.object({
  code: z.number(),
  event: z.number(),
  finished: z.boolean(),
  finished_provisional: z.boolean(),
  id: z.number(),
  kickoff_time: z.string(),
  minutes: z.number(),
  provisional_start_time: z.boolean(),
  started: z.boolean(),
  team_a: z.number(),
  team_a_score: z.number().nullable(),
  team_h: z.number(),
  team_h_score: z.number().nullable(),
  stats: z.array(
    z.object({
      identifier: z.string(),
      a: z.array(
        z.object({
          value: z.number(),
          element: z.number(),
        }),
      ),
      h: z.array(
        z.object({
          value: z.number(),
          element: z.number(),
        }),
      ),
    }),
  ),
  team_h_difficulty: z.number(),
  team_a_difficulty: z.number(),
  pulse_id: z.number(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
const FixtureSchema = z.object({
  code: z.number(),
  event: z.number(),
  finished: z.boolean(),
  finishedProvisional: z.boolean(),
  id: z.number(),
  kickoffTime: z.string(),
  minutes: z.number(),
  provisionalStartTime: z.boolean(),
  started: z.boolean(),
  teamAway: z.number(),
  teamAwayScore: z.number().nullable(),
  teamHome: z.number(),
  teamHomeScore: z.number().nullable(),
  stats: z.array(
    z.object({
      identifier: z.string(),
      away: z.array(
        z.object({
          value: z.number(),
          element: z.number(),
        }),
      ),
      home: z.array(
        z.object({
          value: z.number(),
          element: z.number(),
        }),
      ),
    }),
  ),
  teamHomeDifficulty: z.number(),
  teamAwayDifficulty: z.number(),
  pulseId: z.number(),
});

export const FixturesSchema = z.array(FixtureSchema);
export const FixturesResponseSchema = z.array(FixtureResponseSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type FixtureResponse = z.infer<typeof FixtureResponseSchema>;
export type FixturesResponse = z.infer<typeof FixturesResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type Fixture = z.infer<typeof FixtureSchema>;
export type Fixtures = z.infer<typeof FixturesSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate FixtureResponse to Fixture
 */
export const toDomainFixture = (raw: FixtureResponse): Either<string, Fixture> => {
  try {
    const result = FixtureSchema.safeParse({
      code: raw.code,
      event: raw.event,
      finished: raw.finished,
      finishedProvisional: raw.finished_provisional,
      id: raw.id,
      kickoffTime: raw.kickoff_time,
      minutes: raw.minutes,
      provisionalStartTime: raw.provisional_start_time,
      started: raw.started,
      teamAway: raw.team_a,
      teamAwayScore: raw.team_a_score,
      teamHome: raw.team_h,
      teamHomeScore: raw.team_h_score,
      stats: raw.stats.map((stat) => ({
        identifier: stat.identifier,
        away: stat.a.map((item) => ({
          value: item.value,
          element: item.element,
        })),
        home: stat.h.map((item) => ({
          value: item.value,
          element: item.element,
        })),
      })),
      teamHomeDifficulty: raw.team_h_difficulty,
      teamAwayDifficulty: raw.team_a_difficulty,
      pulseId: raw.pulse_id,
    });

    return result.success
      ? right(result.data)
      : left(`Invalid fixture domain model: ${result.error.message}`);
  } catch (error) {
    return left(
      `Failed to transform fixture data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
