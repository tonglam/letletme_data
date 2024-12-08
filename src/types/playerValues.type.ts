import { z } from 'zod';
import { player_value_change_type_enum } from '../constants/enum';

const PlayerValueResponseSchema = z.object({
  id: z.number(),
  element_type: z.number(),
  now_cost: z.number(),
});

const PlayerValueSchema = z.object({
  elementId: z.number(),
  elementType: z.number(),
  eventId: z.number(),
  value: z.number(),
  lastValue: z.number().default(0),
  changeDate: z.string(),
  changeType: z.enum(Object.values(player_value_change_type_enum) as [string, ...string[]]),
});

const PlayerValuesSchema = z.array(PlayerValueSchema);

type PlayerValueResponse = z.infer<typeof PlayerValueResponseSchema>;
type PlayerValue = z.infer<typeof PlayerValueSchema>;

export {
  PlayerValue,
  PlayerValueResponse,
  PlayerValueResponseSchema,
  PlayerValueSchema,
  PlayerValuesSchema,
};
