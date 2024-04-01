import { z } from 'zod';

const ChipPlaySchema = z.object({
  chip_name: z.string(),
  num_played: z.number(),
});

const TopElementInfoSchema = z.object({
  id: z.number(),
  points: z.number(),
});

const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadline_time: z.string(),
  release_time: z.nullable(z.string()),
  average_entry_score: z.number(),
  finished: z.boolean(),
  data_checked: z.boolean(),
  highest_scoring_entry: z.nullable(z.number()),
  deadline_time_epoch: z.number(),
  deadline_time_game_offset: z.number(),
  highest_score: z.nullable(z.number()),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  cup_leagues_created: z.boolean(),
  h2h_ko_matches_created: z.boolean(),
  ranked_count: z.number(),
  chip_plays: z.array(ChipPlaySchema),
  most_selected: z.nullable(z.number()),
  most_transferred_in: z.nullable(z.number()),
  top_element: z.nullable(z.number()),
  top_element_info: z.nullable(TopElementInfoSchema),
  transfers_made: z.number(),
  most_captained: z.nullable(z.number()),
  most_vice_captained: z.nullable(z.number()),
});

const EventsSchema = z.array(EventSchema);

type Event = z.infer<typeof EventSchema>;

type Events = z.infer<typeof EventsSchema>;

export { Event, EventSchema, Events, EventsSchema };
