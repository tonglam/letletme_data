import { z } from 'zod';

const TopElementInfoSchema = z.object({
  id: z.number(),
  points: z.number(),
});

const ChipPlaySchema = z.object({
  chip_name: z.string(),
  num_played: z.number(),
});

const EventResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadline_time: z.string(),
  deadline_time_epoch: z.number(),
  deadline_time_game_offset: z.number(),
  release_time: z.string().nullable(),
  average_entry_score: z.number(),
  finished: z.boolean(),
  data_checked: z.boolean(),
  highest_score: z.number().nullable(),
  highest_scoring_entry: z.number().nullable(),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  cup_leagues_created: z.boolean(),
  h2h_ko_matches_created: z.boolean(),
  ranked_count: z.number(),
  chip_plays: z.array(ChipPlaySchema),
  most_selected: z.number(),
  most_transferred_in: z.number(),
  most_captained: z.number(),
  most_vice_captained: z.number(),
  top_element: z.number(),
  top_element_info: z.any(),
  transfers_made: z.number(),
});

const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadlineTime: z.date(),
  deadlineTimeEpoch: z.number(),
  deadlineTimeGameOffset: z.number(),
  releaseTime: z.date(),
  averageEntryScore: z.number().default(0),
  finished: z.boolean().default(false),
  dataChecked: z.boolean().default(false),
  highestScore: z.number(),
  highestScoringEntry: z.number(),
  isPrevious: z.boolean().default(false),
  isCurrent: z.boolean().default(false),
  isNext: z.boolean().default(false),
  cupLeaguesCreated: z.boolean().default(false),
  h2hKoMatchesCreated: z.boolean().default(false),
  rankedCount: z.number().default(0),
  chipPlays: z.array(ChipPlaySchema).default([]),
  mostSelected: z.number().nullable(),
  mostTransferredIn: z.number().nullable(),
  mostCaptained: z.number().nullable(),
  mostViceCaptained: z.number().nullable(),
  topElement: z.number().nullable(),
  topElementInfo: TopElementInfoSchema.nullable(),
  transfersMade: z.number().default(0),
});

const EventsResponseSchema = z.array(EventResponseSchema);
const EventsSchema = z.array(EventSchema);

type EventResponse = z.infer<typeof EventResponseSchema>;
type EventsResponse = z.infer<typeof EventsResponseSchema>;
type Event = z.infer<typeof EventSchema>;
type Events = z.infer<typeof EventsSchema>;

export {
  Event,
  EventResponse,
  EventResponseSchema,
  Events,
  EventSchema,
  EventsResponse,
  EventsResponseSchema,
  EventsSchema,
};
