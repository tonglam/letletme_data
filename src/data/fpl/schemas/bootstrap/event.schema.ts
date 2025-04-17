import { z } from 'zod';

export const TopElementInfoSchema = z.object({
  id: z.number(),
  points: z.number(),
});

export type TopElementInfo = z.infer<typeof TopElementInfoSchema>;

export const ChipPlaySchema = z.object({
  chip_name: z.string(),
  num_played: z.number(),
});

export type ChipPlay = z.infer<typeof ChipPlaySchema>;

export const EventResponseSchema = z
  .object({
    // Required fields
    id: z.number(),
    name: z.string(),
    deadline_time: z.string(),
    deadline_time_epoch: z.number(),
    finished: z.boolean(),
    is_previous: z.boolean(),
    is_current: z.boolean(),
    is_next: z.boolean(),

    // Fields with default values
    deadline_time_game_offset: z.number().default(0),
    average_entry_score: z.number().default(0),
    data_checked: z.boolean().default(false),
    highest_score: z.number().nullable().default(0),
    highest_scoring_entry: z.number().nullable().default(0),
    cup_leagues_created: z.boolean().default(false),
    h2h_ko_matches_created: z.boolean().default(false),
    ranked_count: z.number().default(0),
    transfers_made: z.number().default(0),

    // Optional fields
    release_time: z.string().nullable().optional(),
    chip_plays: z.array(ChipPlaySchema).default([]),
    most_selected: z.number().nullable().optional(),
    most_transferred_in: z.number().nullable().optional(),
    most_captained: z.number().nullable().optional(),
    most_vice_captained: z.number().nullable().optional(),
    top_element: z.number().nullable().optional(),
    top_element_info: TopElementInfoSchema.nullable().optional(),

    // Other API fields that we don't store or use directly
    release_time_epoch: z.number().nullable().optional(),
    release_time_game_offset: z.number().nullable().optional(),
    chip_plays_processed: z.boolean().optional(),
    released: z.boolean().optional(),
  })
  .passthrough();

export type EventResponse = z.infer<typeof EventResponseSchema>;

export type EventsResponse = readonly EventResponse[];
