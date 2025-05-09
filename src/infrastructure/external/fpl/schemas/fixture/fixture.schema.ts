import { z } from 'zod';

export const EventFixtureResponseSchema = z
  .object({
    id: z.number(),
    code: z.number(),
    event: z.number(),
    kickoff_time: z.string().nullable(),
    started: z.boolean(),
    finished: z.boolean(),
    minutes: z.number(),
    team_h: z.number().nullable(),
    team_h_difficulty: z.number().nullable(),
    team_h_score: z.number().nullable(),
    team_a: z.number().nullable(),
    team_a_difficulty: z.number().nullable(),
    team_a_score: z.number().nullable(),
  })
  .passthrough();

export const EventFixturesResponseSchema = z.array(EventFixtureResponseSchema);

export type EventFixtureResponse = z.infer<typeof EventFixtureResponseSchema>;
export type EventFixturesResponse = readonly EventFixtureResponse[];
