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
  most_selected: z.number().nullable(),
  most_transferred_in: z.number().nullable(),
  most_captained: z.number().nullable(),
  most_vice_captained: z.number().nullable(),
  top_element: z.number().nullable(),
  top_element_info: z.any(),
  transfers_made: z.number()
});

const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadlineTime: z.date(),
  deadlineTimeEpoch: z.number(),
  deadlineTimeGameOffset: z.number(),
  releaseTime: z.date().nullable(),
  averageEntryScore: z.number().optional().default(0),
  finished: z.boolean().optional().default(false),
  dataChecked: z.boolean().optional().default(false),
  highestScore: z.number().nullable(),
  highestScoringEntry: z.number().nullable(),
  isPrevious: z.boolean().optional().default(false),
  isCurrent: z.boolean().optional().default(false),
  isNext: z.boolean().optional().default(false),
  cupLeaguesCreated: z.boolean().optional().default(false),
  h2hKoMatchesCreated: z.boolean().optional().default(false),
  rankedCount: z.number().optional().default(0),
  chipPlays: z.array(ChipPlaySchema).optional().default([]),
  mostSelected: z.number().nullable(),
  mostTransferredIn: z.number().nullable(),
  mostCaptained: z.number().nullable(),
  mostViceCaptained: z.number().nullable(),
  topElement: z.number().nullable(),
  topElementInfo: z.any(),
  transfersMade: z.number().optional().default(0),
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
  EventSchema,
  Events,
  EventsResponse,
  EventsResponseSchema,
  EventsSchema,
  TopElementInfoSchema,
};
