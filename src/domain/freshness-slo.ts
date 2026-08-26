export type FreshnessSloStatus = 'PENDING' | 'MET' | 'BREACHED' | 'INVALID' | 'NOT_APPLICABLE';

export type FreshnessCompletenessStatus =
  | 'PENDING'
  | 'COMPLETE'
  | 'INCOMPLETE'
  | 'INVALID'
  | 'NOT_APPLICABLE';

export type FreshnessWindowObservation = Readonly<{
  eligible: boolean;
  invalid?: boolean;
  dueAt: Date;
  now?: Date;
  sourceCheckedAt?: Date | null;
  pgPublishedAt?: Date | null;
  redisSeenAt?: Date | null;
  graphqlSeenAt?: Date | null;
  producerRevision?: string | null;
  redisRevision?: string | null;
  graphqlRevision?: string | null;
  webRevision?: string | null;
  expectedCount?: number | null;
  observedCount?: number | null;
  completeness?: FreshnessCompletenessStatus;
  webSeenAt?: Date | null;
}>;

const MILESTONE_FIELDS = [
  'sourceCheckedAt',
  'pgPublishedAt',
  'redisSeenAt',
  'graphqlSeenAt',
  'webSeenAt',
] as const;

function isFiniteDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** Every hop in the publication chain must leave timestamped evidence. */
export function milestonesAreComplete(input: FreshnessWindowObservation): boolean {
  return MILESTONE_FIELDS.every((field) => isFiniteDate(input[field]));
}

/** Evidence is only on time when no recorded hop crossed the SLO deadline. */
export function milestonesMeetDeadline(input: FreshnessWindowObservation): boolean {
  if (!milestonesAreComplete(input)) return false;
  return MILESTONE_FIELDS.every((field) => {
    const timestamp = input[field];
    return (
      timestamp !== null && timestamp !== undefined && timestamp.getTime() <= input.dueAt.getTime()
    );
  });
}

export function revisionsAgree(revisions: readonly (string | null | undefined)[]): boolean {
  if (revisions.length === 0 || revisions.some((revision) => !revision)) return false;
  const [first] = revisions;
  return typeof first === 'string' && revisions.every((revision) => revision === first);
}

export function isCompleteCount(
  expectedCount: number | null | undefined,
  observedCount: number | null | undefined,
): boolean {
  return (
    Number.isSafeInteger(expectedCount) &&
    Number.isSafeInteger(observedCount) &&
    Number(expectedCount) >= 0 &&
    Number(expectedCount) === Number(observedCount)
  );
}

export function evaluateFreshnessWindow(input: FreshnessWindowObservation): FreshnessSloStatus {
  if (!input.eligible) return 'NOT_APPLICABLE';
  if (input.invalid) return 'INVALID';
  const now = input.now ?? new Date();
  const complete =
    input.completeness === 'COMPLETE' ||
    (input.completeness === undefined && isCompleteCount(input.expectedCount, input.observedCount));
  const visible = Boolean(input.webSeenAt && input.webSeenAt.getTime() <= input.dueAt.getTime());
  if (
    complete &&
    visible &&
    milestonesMeetDeadline(input) &&
    revisionsAgree([
      input.producerRevision,
      input.redisRevision,
      input.graphqlRevision,
      input.webRevision,
    ])
  ) {
    return 'MET';
  }
  return now.getTime() >= input.dueAt.getTime() ? 'BREACHED' : 'PENDING';
}

/** Once a window has breached, a late repair is recovery evidence, not MET. */
export function applyFreshnessObservation(
  previous: FreshnessSloStatus,
  observation: FreshnessWindowObservation,
): Readonly<{ status: FreshnessSloStatus; recovered: boolean }> {
  if (previous === 'NOT_APPLICABLE') return { status: 'NOT_APPLICABLE', recovered: false };
  // A MET window is a historical success. A later partial/stale probe must
  // not rewrite that success into a breach; a new window carries any future
  // consumer regression.
  if (previous === 'MET') return { status: 'MET', recovered: false };
  if (previous === 'BREACHED') {
    // A late repair is evaluated for completeness and revision parity, but its
    // timestamps are deliberately not compared with the historical deadline.
    // The breach remains immutable while recovered_at records the repair.
    const complete =
      !observation.invalid &&
      observation.completeness === 'COMPLETE' &&
      milestonesAreComplete(observation) &&
      revisionsAgree([
        observation.producerRevision,
        observation.redisRevision,
        observation.graphqlRevision,
        observation.webRevision,
      ]) &&
      (observation.expectedCount == null ||
        isCompleteCount(observation.expectedCount, observation.observedCount));
    return { status: 'BREACHED', recovered: complete };
  }
  const status = evaluateFreshnessWindow(observation);
  return { status, recovered: false };
}

export function calculateBurnRate(breached: number, eligible: number, target = 0.99): number {
  if (eligible <= 0 || target >= 1) return 0;
  const allowedFailureRate = Math.max(1e-9, 1 - target);
  return breached / eligible / allowedFailureRate;
}

export const FRESHNESS_SLO_TARGETS = {
  core: { dispatchWithinMs: 5 * 60_000, completeness: 'source-complete' },
  live: { dispatchWithinMs: 90_000, completeness: 'event-roster-fixtures' },
  livePicks: { dispatchWithinMs: 10 * 60_000, completeness: 'eligible-entry-15-picks' },
  priceChange: { dispatchWithinMs: 10 * 60_000, completeness: 'expected-player-count' },
  marketDaily: { dueAt: '09:35 Asia/Shanghai', completeness: 'source-day-artifact' },
  entry: { dispatchWithinMs: 15 * 60_000, completeness: 'eligible-entry' },
  provisional: { dispatchWithinMs: 60 * 60_000, completeness: 'eligible-entry-tournament' },
  final: { dispatchWithinMs: 15 * 60_000, completeness: 'provisional-scope' },
  officialH2H: { executionWithinMs: 45_000, completeness: 'locked-manifest' },
  playerSummary: { dispatchWithinMs: 15 * 60_000, completeness: 'core-player' },
  myFplDaily: { dueAt: '11:00 Asia/Shanghai', completeness: 'scope-outbox' },
  bootstrapArchive: { dispatchWithinMs: 0, completeness: 'exact-source-day-sha' },
} as const;
