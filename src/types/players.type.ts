import { z } from 'zod';

const PlayerResponseSchema = z.object({
  id: z.number(),
  code: z.number(),
  now_cost: z.number(),
  cost_change_start: z.number(),
  element_type: z.number(),
  first_name: z.string().nullable(),
  second_name: z.string().nullable(),
  web_name: z.string(),
  team: z.number(),
});

const PlayerSchema = z.object({
  element: z.number(),
  elementCode: z.number(),
  price: z.number().default(0),
  startPrice: z.number().default(0),
  elementType: z.number(),
  firstName: z.string().nullable(),
  secondName: z.string().nullable(),
  webName: z.string(),
  teamId: z.number(),
});

const PlayersSchema = z.array(PlayerSchema);

type PlayerResponse = z.infer<typeof PlayerResponseSchema>;
type Player = z.infer<typeof PlayerSchema>;

export { Player, PlayerResponse, PlayerResponseSchema, PlayerSchema, PlayersSchema };
