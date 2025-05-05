import { z } from 'zod';

import { EventIDSchema } from '../shared/types/id.types';
import { ChipPlaySchema } from '../shared/value-objects/chip-play.types';
import { TopElementInfoSchema } from '../shared/value-objects/top-element.types';

export const EventSchema = z.object({
  id: EventIDSchema,
  name: z.string().min(1, { message: 'Event name cannot be empty' }),
  deadlineTime: z.coerce.date(),
  finished: z.boolean(),
  isPrevious: z.boolean(),
  isCurrent: z.boolean(),
  isNext: z.boolean(),
  averageEntryScore: z.number(),
  dataChecked: z.boolean(),
  highestScore: z.number().nullable(),
  highestScoringEntry: z.number().nullable(),
  cupLeaguesCreated: z.boolean(),
  h2hKoMatchesCreated: z.boolean(),
  transfersMade: z.number(),
  rankedCount: z.number(),
  chipPlays: z.array(ChipPlaySchema),
  mostSelected: z.number().nullable(),
  mostTransferredIn: z.number().nullable(),
  mostCaptained: z.number().nullable(),
  mostViceCaptained: z.number().nullable(),
  topElement: z.number().nullable(),
  topElementInfo: TopElementInfoSchema.nullable(),
});
