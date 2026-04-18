import { z } from 'zod';

import type { EventId } from '../types/base.type';

/**
 * Live Bonus Cache Data
 *
 * Cache structure: LiveBonus:{season}:{eventId} -> hash of teamId -> {elementId: bonus}
 * Example: LiveBonus:2526:22 -> {"1": "{\"123\":3,\"456\":2,\"789\":1}", "2": "{\"234\":3}"}
 */
export type LiveBonusByTeam = Readonly<Record<string, Record<string, number>>>;

export interface LiveBonusCachePayload {
  readonly eventId: EventId;
  readonly byTeam: LiveBonusByTeam;
}

export const LiveBonusByTeamSchema = z.record(z.record(z.number().int().min(0).max(3)));

export const LiveBonusCachePayloadSchema = z.object({
  eventId: z.number().int().positive(),
  byTeam: LiveBonusByTeamSchema,
});

export function validateLiveBonusCachePayload(data: unknown): LiveBonusCachePayload {
  return LiveBonusCachePayloadSchema.parse(data);
}

export function safeValidateLiveBonusCachePayload(data: unknown): LiveBonusCachePayload | null {
  const result = LiveBonusCachePayloadSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function getBonusForElement(
  payload: LiveBonusCachePayload,
  teamId: string,
  elementId: string,
): number {
  return payload.byTeam[teamId]?.[elementId] ?? 0;
}

export function hasAnyBonus(payload: LiveBonusCachePayload): boolean {
  return Object.values(payload.byTeam).some((team) => Object.keys(team).length > 0);
}
