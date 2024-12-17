import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';

// ============ Schemas ============
/**
 * Sub-schemas for nested objects
 */
const TopElementInfoSchema = z.object({
  id: z.number(),
  points: z.number(),
});

const ChipPlaySchema = z.object({
  chip_name: z.string(),
  num_played: z.number(),
});

/**
 * API Response Schema - Validates external API data (snake_case)
 */
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
  top_element_info: TopElementInfoSchema.nullable(),
  transfers_made: z.number(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadlineTime: z.date(),
  deadlineTimeEpoch: z.number(),
  deadlineTimeGameOffset: z.number(),
  releaseTime: z.date().nullable(),
  averageEntryScore: z.number(),
  finished: z.boolean(),
  dataChecked: z.boolean(),
  highestScore: z.number().nullable(),
  highestScoringEntry: z.number().nullable(),
  isPrevious: z.boolean(),
  isCurrent: z.boolean(),
  isNext: z.boolean(),
  cupLeaguesCreated: z.boolean(),
  h2hKoMatchesCreated: z.boolean(),
  rankedCount: z.number(),
  chipPlays: z.array(ChipPlaySchema),
  mostSelected: z.number().nullable(),
  mostTransferredIn: z.number().nullable(),
  mostCaptained: z.number().nullable(),
  mostViceCaptained: z.number().nullable(),
  topElement: z.number().nullable(),
  topElementInfo: TopElementInfoSchema.nullable(),
  transfersMade: z.number(),
});

export const EventsResponseSchema = z.array(EventResponseSchema);
export const EventsSchema = z.array(EventSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type EventResponse = z.infer<typeof EventResponseSchema>;
export type EventsResponse = z.infer<typeof EventsResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type Event = z.infer<typeof EventSchema>;
export type Events = z.infer<typeof EventsSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate EventResponse to Event
 */
export const toDomainEvent = (raw: EventResponse): Either<string, Event> => {
  try {
    const result = EventSchema.safeParse({
      id: raw.id,
      name: raw.name,
      deadlineTime: new Date(raw.deadline_time),
      deadlineTimeEpoch: raw.deadline_time_epoch,
      deadlineTimeGameOffset: raw.deadline_time_game_offset,
      releaseTime: raw.release_time ? new Date(raw.release_time) : null,
      averageEntryScore: raw.average_entry_score,
      finished: raw.finished,
      dataChecked: raw.data_checked,
      highestScore: raw.highest_score,
      highestScoringEntry: raw.highest_scoring_entry,
      isPrevious: raw.is_previous,
      isCurrent: raw.is_current,
      isNext: raw.is_next,
      cupLeaguesCreated: raw.cup_leagues_created,
      h2hKoMatchesCreated: raw.h2h_ko_matches_created,
      rankedCount: raw.ranked_count,
      chipPlays: raw.chip_plays,
      mostSelected: raw.most_selected,
      mostTransferredIn: raw.most_transferred_in,
      mostCaptained: raw.most_captained,
      mostViceCaptained: raw.most_vice_captained,
      topElement: raw.top_element,
      topElementInfo: raw.top_element_info,
      transfersMade: raw.transfers_made,
    });

    return result.success
      ? right(result.data)
      : left(`Invalid event domain model: ${result.error.message}`);
  } catch (error) {
    return left(
      `Failed to transform event data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
