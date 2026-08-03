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

/**
 * Old queue names can survive a rolling worker deployment. Treat every job
 * that used to replace one live Redis view as a coordinated snapshot so none
 * can invalidate LiveSnapshotMeta after the new publisher is active.
 */
export function resolveLiveSnapshotPersistence(
  jobName: string,
  requestedPersistence = false,
): boolean | null {
  switch (jobName) {
    case 'live-snapshot':
      return requestedPersistence;
    case 'event-lives-db':
      return true;
    case 'event-lives-cache':
    case 'live-fixture-cache':
    case 'live-bonus-cache':
    case 'live-scores':
      return false;
    default:
      return null;
  }
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
