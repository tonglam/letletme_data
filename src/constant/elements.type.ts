import { z } from 'zod';

const ElementSchema = z.object({
  id: z.string(),
  elementId: z.number(),
  elementCode: z.number(),
  price: z.number().nullable(),
  startPrice: z.number().nullable(),
  elementType: z.number(),
  firstName: z.string().nullable(),
  secondName: z.string().nullable(),
  webName: z.string(),
  teamId: z.number(),
  status: z.string().nullable(),
  chanceOfPlayingNextRound: z.number().nullable(),
  chanceOfPlayingThisRound: z.number().nullable(),
  inDreamteam: z.boolean().default(false),
  dreamteamCount: z.number().default(0),
  createdAt: z.string().transform((val) => new Date(val)),
});

// Player statistics schema
const ElementStatSchema = z.object({
  id: z.string(),
  eventId: z.number(),
  elementId: z.number(),
  teamId: z.number(),
  form: z.number().nullable(),
  influence: z.number().nullable(),
  creativity: z.number().nullable(),
  threat: z.number().nullable(),
  ictIndex: z.number().nullable(),
  expectedGoals: z.number().nullable(),
  expectedAssists: z.number().nullable(),
  expectedGoalInvolvements: z.number().nullable(),
  expectedGoalsConceded: z.number().nullable(),
  minutes: z.number().nullable(),
  goalsScored: z.number().nullable(),
  assists: z.number().nullable(),
  cleanSheets: z.number().nullable(),
  goalsConceded: z.number().nullable(),
  ownGoals: z.number().nullable(),
  penaltiesSaved: z.number().nullable(),
  createdAt: z.string().transform((val) => new Date(val)),
  updatedAt: z.string().transform((val) => new Date(val)),
});

// Player value change type
const PlayerValueChangeTypeEnum = z.enum(['Start', 'Rise', 'Fall']);

// Player value schema
const ElementValueSchema = z.object({
  id: z.string(),
  elementId: z.number(),
  elementType: z.number(),
  eventId: z.number(),
  value: z.number(),
  lastValue: z.number().default(0),
  changeDate: z.string().default(''),
  changeType: PlayerValueChangeTypeEnum.default('Start'),
  createdAt: z.string().transform((val) => new Date(val)),
  updatedAt: z.string().transform((val) => new Date(val)),
});

// Live performance schema
const ElementLiveSchema = z.object({
  id: z.string(),
  eventId: z.number(),
  elementId: z.number(),
  stats: z.record(z.unknown()),
  explanations: z.record(z.unknown()).nullable(),
  createdAt: z.string().transform((val) => new Date(val)),
  updatedAt: z.string().transform((val) => new Date(val)),
});

const ElementsSchema = z.array(ElementSchema);

type Element = z.infer<typeof ElementSchema>;
type Elements = z.infer<typeof ElementsSchema>;
type ElementStat = z.infer<typeof ElementStatSchema>;
type ElementValue = z.infer<typeof ElementValueSchema>;
type ElementLive = z.infer<typeof ElementLiveSchema>;
type PlayerValueChangeType = z.infer<typeof PlayerValueChangeTypeEnum>;

export {
  Element,
  ElementLive,
  ElementLiveSchema,
  Elements,
  ElementSchema,
  ElementsSchema,
  ElementStat,
  ElementStatSchema,
  ElementValue,
  ElementValueSchema,
  PlayerValueChangeType,
  PlayerValueChangeTypeEnum,
};
