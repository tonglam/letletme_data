import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';

// ============ Branded Types ============
export type EventFixtureId = Branded<string, 'EventFixtureId'>;

export const EventFixtureId = createBrandedType<string, 'EventFixtureId'>(
  'EventFixtureId',
  (value: unknown): value is string => typeof value === 'string' && value.length > 0,
);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export interface EventFixtureResponse {
  readonly code: number;
  readonly event: number;
  readonly finished: boolean;
  readonly finished_provisional: boolean;
  readonly id: number;
  readonly kickoff_time: string | null;
  readonly minutes: number;
  readonly provisional_start_time: boolean;
  readonly started: boolean;
  readonly team_a: number;
  readonly team_a_score: number | null;
  readonly team_h: number;
  readonly team_h_score: number | null;
  readonly team_h_difficulty: number;
  readonly team_a_difficulty: number;
}

export type EventFixturesResponse = readonly EventFixtureResponse[];

/**
 * Domain types (camelCase)
 */
export interface EventFixture {
  readonly id: EventFixtureId;
  readonly code: number;
  readonly event: number;
  readonly kickoffTime: string | null;
  readonly started: boolean;
  readonly finished: boolean;
  readonly provisionalStartTime: boolean;
  readonly finishedProvisional: boolean;
  readonly minutes: number;
  readonly teamH: number | null;
  readonly teamHDifficulty: number;
  readonly teamHScore: number;
  readonly teamA: number | null;
  readonly teamADifficulty: number;
  readonly teamAScore: number;
}

export type EventFixtures = readonly EventFixture[];

// ============ Repository Interface ============
export type EventFixtureRepository = BaseRepository<
  PrismaEventFixture,
  PrismaEventFixtureCreate,
  EventFixtureId
>;

// ============ Persistence Types ============
export interface PrismaEventFixture {
  readonly id: string;
  readonly code: number;
  readonly event: number;
  readonly kickoffTime: string | null;
  readonly started: boolean;
  readonly finished: boolean;
  readonly provisionalStartTime: boolean;
  readonly finishedProvisional: boolean;
  readonly minutes: number;
  readonly teamH: number | null;
  readonly teamHDifficulty: number;
  readonly teamHScore: number;
  readonly teamA: number | null;
  readonly teamADifficulty: number;
  readonly teamAScore: number;
  readonly createdAt: Date;
}

export type PrismaEventFixtureCreate = Omit<PrismaEventFixture, 'id' | 'createdAt'>;

// ============ Converters ============
export const toDomainEventFixture = (
  data: EventFixtureResponse | PrismaEventFixture,
): EventFixture => {
  const isEventFixtureApiResponse = (
    d: EventFixtureResponse | PrismaEventFixture,
  ): d is EventFixtureResponse => isApiResponse(d, 'team_h_score');

  return {
    id: (isEventFixtureApiResponse(data) ? String(data.id) : data.id) as EventFixtureId,
    code: data.code,
    event: data.event,
    kickoffTime: isEventFixtureApiResponse(data) ? data.kickoff_time : data.kickoffTime,
    started: data.started,
    finished: data.finished,
    provisionalStartTime: isEventFixtureApiResponse(data)
      ? data.provisional_start_time
      : data.provisionalStartTime,
    finishedProvisional: isEventFixtureApiResponse(data)
      ? data.finished_provisional
      : data.finishedProvisional,
    minutes: data.minutes,
    teamH: isEventFixtureApiResponse(data) ? data.team_h : data.teamH,
    teamHDifficulty: isEventFixtureApiResponse(data)
      ? data.team_h_difficulty
      : data.teamHDifficulty,
    teamHScore: isEventFixtureApiResponse(data) ? data.team_h_score ?? 0 : data.teamHScore,
    teamA: isEventFixtureApiResponse(data) ? data.team_a : data.teamA,
    teamADifficulty: isEventFixtureApiResponse(data)
      ? data.team_a_difficulty
      : data.teamADifficulty,
    teamAScore: isEventFixtureApiResponse(data) ? data.team_a_score ?? 0 : data.teamAScore,
  };
};

export const convertPrismaEventFixtures = (
  fixtures: readonly PrismaEventFixture[],
): TE.TaskEither<string, EventFixtures> =>
  pipe(
    fixtures,
    TE.right,
    TE.map((values) => values.map(toDomainEventFixture)),
  );

export const convertPrismaEventFixture = (
  fixture: PrismaEventFixture | null,
): TE.TaskEither<string, EventFixture | null> =>
  TE.right(fixture ? toDomainEventFixture(fixture) : null);

export const EventFixtureResponseSchema = z.object({
  code: z.number(),
  event: z.number(),
  finished: z.boolean(),
  finished_provisional: z.boolean(),
  id: z.number(),
  kickoff_time: z.string().nullable(),
  minutes: z.number(),
  provisional_start_time: z.boolean(),
  started: z.boolean(),
  team_a: z.number(),
  team_a_score: z.number().nullable(),
  team_h: z.number(),
  team_h_score: z.number().nullable(),
  team_h_difficulty: z.number(),
  team_a_difficulty: z.number(),
});
