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
  average_entry_score: z.number().default(0),
  finished: z.boolean().default(false),
  data_checked: z.boolean().default(false),
  highest_score: z.number().nullable().default(0),
  highest_scoring_entry: z.number().nullable().default(null),
  is_previous: z.boolean().default(false),
  is_current: z.boolean().default(false),
  is_next: z.boolean().default(false),
  cup_leagues_created: z.boolean().default(false),
  h2h_ko_matches_created: z.boolean().default(false),
  ranked_count: z.number().default(0),
  chip_plays: z.array(ChipPlaySchema).default([]),
  most_selected: z.number().nullable(),
  most_transferred_in: z.number().nullable(),
  most_captained: z.number().nullable(),
  most_vice_captained: z.number().nullable(),
  top_element: z.number().nullable(),
  top_element_info: z.any().nullable(),
  transfers_made: z.number().default(0),
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
  createdAt: z.date(),
});

const EventsSchema = z.array(EventSchema);

type EventResponse = z.infer<typeof EventResponseSchema>;
type Event = z.infer<typeof EventSchema>;
type Events = z.infer<typeof EventsSchema>;

export { Event, EventResponse, EventResponseSchema, Events, EventSchema, EventsSchema };
