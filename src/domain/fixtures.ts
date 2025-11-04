import { z } from 'zod';

import type { Fixture, RawFPLFixture } from '../types';

// ================================
// Domain Validation Schemas
// ================================

export const FixtureSchema = z.object({
  id: z.number().int().positive('Fixture ID must be a positive integer'),
  code: z.number().int().positive('Fixture code must be a positive integer'),
  event: z.number().int().min(1).max(38).nullable(),
  finished: z.boolean(),
  finishedProvisional: z.boolean(),
  kickoffTime: z.date().nullable(),
  minutes: z.number().int().min(0, 'Minutes cannot be negative'),
  provisionalStartTime: z.boolean(),
  started: z.boolean().nullable(),
  teamA: z.number().int().positive('Away team ID must be a positive integer'),
  teamAScore: z.number().int().min(0).nullable(),
  teamH: z.number().int().positive('Home team ID must be a positive integer'),
  teamHScore: z.number().int().min(0).nullable(),
  stats: z
    .array(
      z.object({
        identifier: z.string(),
        a: z
          .array(
            z.object({
              value: z.number().int(),
              element: z.number().int().positive(),
            }),
          )
          .default([]),
        h: z
          .array(
            z.object({
              value: z.number().int(),
              element: z.number().int().positive(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  teamHDifficulty: z.number().int().min(1).max(5).nullable(),
  teamADifficulty: z.number().int().min(1).max(5).nullable(),
  pulseId: z.number().int().positive('Pulse ID must be a positive integer'),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export const RawFPLFixtureSchema = z.object({
  code: z.number().int().positive(),
  event: z.number().int().min(1).max(38).nullable(),
  finished: z.boolean(),
  finished_provisional: z.boolean(),
  id: z.number().int().positive(),
  kickoff_time: z.string().nullable(),
  minutes: z.number().int().min(0),
  provisional_start_time: z.boolean(),
  started: z.boolean().nullable(),
  team_a: z.number().int().positive(),
  team_a_score: z.number().int().min(0).nullable(),
  team_h: z.number().int().positive(),
  team_h_score: z.number().int().min(0).nullable(),
  stats: z
    .array(
      z.object({
        identifier: z.string(),
        a: z.array(
          z.object({
            value: z.number().int(),
            element: z.number().int().positive(),
          }),
        ),
        h: z.array(
          z.object({
            value: z.number().int(),
            element: z.number().int().positive(),
          }),
        ),
      }),
    )
    .default([]),
  team_h_difficulty: z.number().int().min(1).max(5).nullable(),
  team_a_difficulty: z.number().int().min(1).max(5).nullable(),
  pulse_id: z.number().int().positive(),
});

// ================================
// Domain Business Logic
// ================================

export function isFixtureFinished(fixture: Fixture): boolean {
  return Boolean(fixture.finished);
}

export function isFixtureUpcoming(fixture: Fixture): boolean {
  return !fixture.finished && fixture.kickoffTime !== null;
}

export function getFixtureScoreline(fixture: Fixture): string {
  if (fixture.teamHScore == null || fixture.teamAScore == null) {
    return 'TBD';
  }

  return `${fixture.teamHScore}-${fixture.teamAScore}`;
}

export function getFixtureWinner(fixture: Fixture): 'home' | 'away' | 'draw' | 'unknown' {
  if (fixture.teamHScore == null || fixture.teamAScore == null) {
    return 'unknown';
  }

  if (fixture.teamHScore > fixture.teamAScore) return 'home';
  if (fixture.teamHScore < fixture.teamAScore) return 'away';
  return 'draw';
}

export function getDifficultyForTeam(fixture: Fixture, isHome: boolean): number | null {
  const homeDifficulty = fixture.teamHDifficulty ?? null;
  const awayDifficulty = fixture.teamADifficulty ?? null;

  return isHome ? homeDifficulty : awayDifficulty;
}

// ================================
// Validation Helpers
// ================================

export function validateFixture(fixture: unknown): Fixture {
  return FixtureSchema.parse(fixture);
}

export function validateFixtures(fixtures: unknown[]): Fixture[] {
  return fixtures.map(validateFixture);
}

export function validateRawFPLFixture(rawFixture: unknown): RawFPLFixture {
  return RawFPLFixtureSchema.parse(rawFixture);
}

export function validateRawFPLFixtures(rawFixtures: unknown[]): RawFPLFixture[] {
  return rawFixtures.map(validateRawFPLFixture);
}

export type ValidatedFixture = z.infer<typeof FixtureSchema>;
export type ValidatedRawFPLFixture = z.infer<typeof RawFPLFixtureSchema>;
