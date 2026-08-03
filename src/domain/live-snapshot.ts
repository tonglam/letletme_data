import { z } from 'zod';

export const LIVE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const LiveSnapshotStateSchema = z.enum(['scheduled', 'live', 'settled']);

export const LiveSnapshotMetaSchema = z.object({
  schemaVersion: z.literal(LIVE_SNAPSHOT_SCHEMA_VERSION),
  season: z.string().regex(/^\d{4}$/),
  eventId: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{24}$/),
  state: LiveSnapshotStateSchema,
  publishedAt: z.string().datetime(),
  checkedAt: z.string().datetime(),
  eventLiveCount: z.number().int().positive(),
  fixtureCount: z.number().int().positive(),
  fixtureTeamCount: z.number().int().positive(),
  bonusTeamCount: z.number().int().min(0),
});

export type LiveSnapshotState = z.infer<typeof LiveSnapshotStateSchema>;
export type LiveSnapshotMeta = z.infer<typeof LiveSnapshotMetaSchema>;

export function shouldSkipQueuedLiveSnapshot(
  source: 'cron' | 'manual' | 'cascade',
  persistEventLives: boolean,
  windowOpen: boolean,
): boolean {
  return source === 'cron' && !persistEventLives && !windowOpen;
}

export function parseLiveSnapshotMeta(value: string | null): LiveSnapshotMeta | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = LiveSnapshotMetaSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
