import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';

import { ValidationError } from '../utils/errors';

export const LEAGUE_JOBS = {
  LEAGUE_EVENT_PICKS: 'league-event-picks',
  LEAGUE_EVENT_RESULTS: 'league-event-results',
} as const;

export type LeagueSyncJobName = (typeof LEAGUE_JOBS)[keyof typeof LEAGUE_JOBS];

export const INVALID_LEAGUE_SYNC_JOB_CODE = 'INVALID_LEAGUE_SYNC_JOB' as const;

export interface LeagueSyncJobData {
  seasonId: number;
  seasonCode: string;
  eventId: number;
  tournamentId?: number; // If specified, process only this tournament; if not, coordinator job
  source: 'cron' | 'manual' | 'cascade' | 'catchup' | 'reconcile';
  triggeredAt: string;
  /** Stable database-clock reuse cutoff retained across BullMQ attempts. */
  freshAfter?: string;
  /** Correlates a coordinator and all of its per-tournament child attempts. */
  runId?: string;
  /** Durable scheduler obligation identity carried through coordinator jobs. */
  obligationId?: string;
  obligationGeneration?: number;
  /** Exact freshness window being repaired. */
  freshnessWindowId?: number;
}

const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger, 'must be a safe integer');
const nonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'must be a safe integer');
const isoTimestamp = z.string().datetime({ offset: true });

/**
 * BullMQ's generic type is compile-time only. Keep this boundary permissive to
 * preserve forward-compatible fields, while rejecting malformed values before
 * they can enter a deterministic job ID or reach a database-backed worker.
 */
export const LeagueSyncJobDataSchema = z
  .object({
    seasonId: positiveSafeInteger,
    seasonCode: z.string().regex(/^\d{4}$/),
    eventId: positiveSafeInteger,
    tournamentId: positiveSafeInteger.optional(),
    source: z.enum(['cron', 'manual', 'cascade', 'catchup', 'reconcile']),
    triggeredAt: isoTimestamp,
    freshAfter: isoTimestamp.optional(),
    runId: z.string().min(1).max(256).optional(),
    obligationId: z.string().uuid().optional(),
    obligationGeneration: nonNegativeSafeInteger.optional(),
    freshnessWindowId: positiveSafeInteger.optional(),
  })
  .passthrough()
  .superRefine((data, context) => {
    const hasObligationId = data.obligationId !== undefined;
    const hasObligationGeneration = data.obligationGeneration !== undefined;
    if (hasObligationId === hasObligationGeneration) return;

    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['obligationId'],
      message: 'obligationId and obligationGeneration must be provided together',
    });
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['obligationGeneration'],
      message: 'obligationId and obligationGeneration must be provided together',
    });
  });

export function isLeagueSyncJobName(value: unknown): value is LeagueSyncJobName {
  return value === LEAGUE_JOBS.LEAGUE_EVENT_PICKS || value === LEAGUE_JOBS.LEAGUE_EVENT_RESULTS;
}

export function validateLeagueSyncJobData(value: unknown): LeagueSyncJobData {
  const parsed = LeagueSyncJobDataSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      'League sync job payload is invalid.',
      INVALID_LEAGUE_SYNC_JOB_CODE,
      parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    );
  }
  return parsed.data as LeagueSyncJobData;
}

export function parseLeagueSyncJobData(value: unknown): LeagueSyncJobData {
  return validateLeagueSyncJobData(value);
}

export class InvalidLeagueSyncJobError extends UnrecoverableError {
  readonly code = INVALID_LEAGUE_SYNC_JOB_CODE;

  constructor() {
    super(INVALID_LEAGUE_SYNC_JOB_CODE);
    this.name = 'InvalidLeagueSyncJobError';
  }
}
