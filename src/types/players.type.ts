import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';

// API Response Schema (snake_case)
export const PlayerResponseSchema = z.object({
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

// Element Type Enum
export enum ElementType {
  GKP = 1,
  DEF = 2,
  MID = 3,
  FWD = 4,
}

export const ElementTypeNames: Record<ElementType, string> = {
  [ElementType.GKP]: 'Goalkeeper',
  [ElementType.DEF]: 'Defender',
  [ElementType.MID]: 'Midfielder',
  [ElementType.FWD]: 'Forward',
};

// Utility function to get element type name
export const getElementTypeName = (type: ElementType): string => ElementTypeNames[type];

// Domain Schema (camelCase)
export const PlayerSchema = z.object({
  element: z.number(),
  elementCode: z.number(),
  price: z.number(),
  startPrice: z.number(),
  elementType: z.nativeEnum(ElementType),
  firstName: z.string().nullable(),
  secondName: z.string().nullable(),
  webName: z.string(),
  teamId: z.number(),
});

export type PlayerResponse = z.infer<typeof PlayerResponseSchema>;
export type Player = Readonly<z.infer<typeof PlayerSchema>>;
export type BootstrapStrategy = 'players' | 'values' | 'stats' | 'all';

// Validation
export const validatePlayerResponse = (data: unknown): E.Either<Error, PlayerResponse> =>
  pipe(
    E.tryCatch(
      () => PlayerResponseSchema.parse(data),
      (error) => new Error(`Invalid player response: ${error}`),
    ),
  );

// Transformation
export const transformPlayerResponse = (response: PlayerResponse): E.Either<Error, Player> =>
  pipe(
    validatePlayerResponse(response),
    E.map((validated) => ({
      element: validated.id,
      elementCode: validated.code,
      price: validated.now_cost,
      startPrice: validated.cost_change_start,
      elementType: validated.element_type as ElementType,
      firstName: validated.first_name,
      secondName: validated.second_name,
      webName: validated.web_name,
      teamId: validated.team,
    })),
  );

// Date format validator
const isValidDateFormat = (value: string): boolean => {
  if (!/^\d{8}$/.test(value)) return false;

  const year = parseInt(value.substring(0, 4), 10);
  const month = parseInt(value.substring(4, 6), 10) - 1;
  const day = parseInt(value.substring(6, 8), 10);

  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
};

export const formatDateToString = (date: Date): string =>
  date.getFullYear().toString() +
  (date.getMonth() + 1).toString().padStart(2, '0') +
  date.getDate().toString().padStart(2, '0');

// Zod custom validator for date string
export const DateStringSchema = z.string().length(8).refine(isValidDateFormat, {
  message: 'Invalid date format. Expected: yyyyMMdd',
});

// UUID pattern validation
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Add to existing PlayerValue schema
export const PlayerValueSchema = z.object({
  id: z.string().uuid().regex(uuidPattern, 'Invalid UUID format'),
  elementId: z.number(),
  elementType: z.number(),
  eventId: z.number(),
  value: z.number(),
  lastValue: z.number(),
  changeDate: DateStringSchema,
  changeType: z.enum(['Start', 'Rise', 'Fall']),
  // ... other fields
});
