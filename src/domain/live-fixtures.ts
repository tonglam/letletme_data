import { z } from 'zod';

import type { EventId, TeamId } from '../types/base.type';

export type MatchPlayStatus = 'Playing' | 'Not_Start' | 'Finished';

export interface LiveFixtureData {
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly teamScore: number;
  readonly teamPosition: number;
  readonly againstId: TeamId;
  readonly againstName: string;
  readonly againstShortName: string;
  readonly againstTeamScore: number;
  readonly againstTeamPosition: number;
  readonly kickoffTime: string | null;
  readonly score: string;
  readonly wasHome: boolean;
  readonly started: boolean;
  readonly finished: boolean;
}

/**
 * Additive fixture-scoped contract used by new consumers. The legacy
 * `LiveFixture` payload is frozen, so fixture identity lives under the
 * `LiveFixtureV2` key instead of changing existing values in place.
 */
export interface LiveFixtureDataV2 extends LiveFixtureData {
  readonly fixtureId: number;
}

export interface LiveFixtureByStatus {
  readonly Playing: LiveFixtureData[];
  readonly Not_Start: LiveFixtureData[];
  readonly Finished: LiveFixtureData[];
}

export type LiveFixturesByTeam = Readonly<Record<string, LiveFixtureByStatus>>;

export interface LiveFixtureByStatusV2 {
  readonly Playing: LiveFixtureDataV2[];
  readonly Not_Start: LiveFixtureDataV2[];
  readonly Finished: LiveFixtureDataV2[];
}

export type LiveFixturesV2ByTeam = Readonly<Record<string, LiveFixtureByStatusV2>>;

export interface LiveFixturesCachePayload {
  readonly eventId: EventId;
  readonly byTeam: LiveFixturesByTeam;
}

export const LiveFixtureDataSchema = z.object({
  teamId: z.number().int().positive(),
  teamName: z.string().min(1),
  teamShortName: z.string().min(1),
  teamScore: z.number().int().min(0),
  teamPosition: z.number().int().positive(),
  againstId: z.number().int().positive(),
  againstName: z.string().min(1),
  againstShortName: z.string().min(1),
  againstTeamScore: z.number().int().min(0),
  againstTeamPosition: z.number().int().positive(),
  kickoffTime: z.string().nullable(),
  score: z.string(),
  wasHome: z.boolean(),
  started: z.boolean(),
  finished: z.boolean(),
});

export const LiveFixtureDataV2Schema = LiveFixtureDataSchema.extend({
  fixtureId: z.number().int().positive(),
});

export const LiveFixturesCachePayloadSchema = z.object({
  eventId: z.number().int().positive(),
  byTeam: z.record(
    z.object({
      Playing: z.array(LiveFixtureDataSchema),
      Not_Start: z.array(LiveFixtureDataSchema),
      Finished: z.array(LiveFixtureDataSchema),
    }),
  ),
});

export function validateLiveFixtureData(data: unknown): LiveFixtureData {
  return LiveFixtureDataSchema.parse(data);
}

export function validateLiveFixturesCachePayload(data: unknown): LiveFixturesCachePayload {
  return LiveFixturesCachePayloadSchema.parse(data);
}

export function safeValidateLiveFixturesCachePayload(
  data: unknown,
): LiveFixturesCachePayload | null {
  const result = LiveFixturesCachePayloadSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function isMatchInProgress(fixture: LiveFixtureData): boolean {
  return fixture.started && !fixture.finished;
}

export function isMatchFinished(fixture: LiveFixtureData): boolean {
  return fixture.finished;
}

export function isMatchNotStarted(fixture: LiveFixtureData): boolean {
  return !fixture.started && !fixture.finished;
}

export function getMatchStatus(fixture: LiveFixtureData): MatchPlayStatus {
  if (isMatchFinished(fixture)) return 'Finished';
  if (isMatchInProgress(fixture)) return 'Playing';
  return 'Not_Start';
}
