import { z } from 'zod';

import { ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Event, RawFPLEvent } from '../types';

const ChipPlaySchema = z.union([
  z.object({ chip_name: z.string(), num_played: z.number() }),
  z.object({ name: z.string(), num_played: z.number() }),
]);

const TopElementInfoSchema = z.union([
  z.object({ element: z.number(), points: z.number() }),
  z.object({ id: z.number(), points: z.number() }),
]);

const RawFPLEventSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  deadline_time: z.string().nullable().optional(),
  average_entry_score: z.number().nullable().optional(),
  finished: z.boolean(),
  data_checked: z.boolean(),
  highest_scoring_entry: z.number().nullable().optional(),
  deadline_time_epoch: z.number().nullable().optional(),
  deadline_time_game_offset: z.number().nullable().optional(),
  highest_score: z.number().nullable().optional(),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  cup_leagues_created: z.boolean(),
  h2h_ko_matches_created: z.boolean(),
  chip_plays: z.array(ChipPlaySchema).optional().default([]),
  most_selected: z.number().nullable().optional(),
  most_transferred_in: z.number().nullable().optional(),
  top_element: z.number().nullable().optional(),
  top_element_info: TopElementInfoSchema.nullable().optional(),
  transfers_made: z.number().nullable().optional(),
  most_captained: z.number().nullable().optional(),
  most_vice_captained: z.number().nullable().optional(),
});

export function transformEvent(rawEvent: RawFPLEvent): Event {
  try {
    const validated = RawFPLEventSchema.parse(rawEvent);
    const topElementInfo = validated.top_element_info
      ? {
          element:
            'element' in validated.top_element_info
              ? validated.top_element_info.element
              : validated.top_element_info.id,
          points: validated.top_element_info.points,
        }
      : null;

    return {
      id: validated.id,
      name: validated.name,
      deadlineTime: validated.deadline_time ?? null,
      averageEntryScore: validated.average_entry_score ?? null,
      finished: validated.finished,
      dataChecked: validated.data_checked,
      highestScoringEntry: validated.highest_scoring_entry ?? null,
      deadlineTimeEpoch: validated.deadline_time_epoch ?? null,
      deadlineTimeGameOffset: validated.deadline_time_game_offset ?? null,
      highestScore: validated.highest_score ?? null,
      isPrevious: validated.is_previous,
      isCurrent: validated.is_current,
      isNext: validated.is_next,
      cupLeagueCreate: validated.cup_leagues_created,
      h2hKoMatchesCreated: validated.h2h_ko_matches_created,
      chipPlays: validated.chip_plays.map((cp) => ({
        chipName: 'chip_name' in cp ? cp.chip_name : cp.name,
        numberPlayed: cp.num_played,
      })),
      mostSelected: validated.most_selected ?? null,
      mostTransferredIn: validated.most_transferred_in ?? null,
      topElement: validated.top_element ?? null,
      topElementInfo,
      transfersMade: validated.transfers_made ?? null,
      mostCaptained: validated.most_captained ?? null,
      mostViceCaptained: validated.most_vice_captained ?? null,
      createdAt: null,
      updatedAt: null,
    };
  } catch (error) {
    logError('Failed to transform event', error, { eventId: rawEvent.id });
    throw new ValidationError(
      `Failed to transform event with id: ${rawEvent.id}`,
      'TRANSFORM_ERROR',
      error,
    );
  }
}

export function transformEvents(rawEvents: RawFPLEvent[]): Event[] {
  const events: Event[] = [];
  const errors: Array<{ eventId: number; error: string }> = [];

  for (const rawEvent of rawEvents) {
    try {
      events.push(transformEvent(rawEvent));
    } catch (error) {
      errors.push({
        eventId: rawEvent.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      logError('Skipping invalid event during transformation', error, { eventId: rawEvent.id });
    }
  }

  if (errors.length > 0) {
    logError('Some events failed transformation', {
      totalEvents: rawEvents.length,
      successfulTransforms: events.length,
      failedTransforms: errors.length,
      errors,
    });
  }

  if (events.length === 0 && rawEvents.length > 0) {
    throw new ValidationError('No valid events were transformed', 'ALL_EVENTS_INVALID', {
      originalCount: rawEvents.length,
      errors,
    });
  }

  logInfo('Events transformation completed', {
    totalInput: rawEvents.length,
    successfulOutput: events.length,
    skippedCount: errors.length,
  });

  return events;
}
