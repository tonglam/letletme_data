export type PollPhase = 'NORMAL' | 'APPROACHING' | 'FINAL_90';

export type PollPolicy = Readonly<{
  normalMinutes?: number;
  approachingMinutes?: number;
  approachingWindowMinutes?: number;
  final90Minutes?: number;
  final90Enabled?: boolean;
  final90Budget?: number;
  editorOnDutyUntil?: string;
  deadlineAt?: string;
  safetyLagMinutes?: number;
  overlapMinutes?: number;
  maxCatchupMinutes?: number;
}>;

// The default runtime ceiling is two X calls per poll.  Callers that load a
// different CONTENT_POLL_MAX_X_CALLS value pass it explicitly so a FINAL_90
// policy can never reserve less budget than one worker invocation consumes.
export const DEFAULT_POLL_MAX_X_CALLS = 2;

function policyObject(policy: unknown): PollPolicy {
  return policy && typeof policy === 'object' && !Array.isArray(policy)
    ? (policy as PollPolicy)
    : {};
}

function policyNumber(policy: unknown, key: keyof PollPolicy, fallback: number): number {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return fallback;
  const value = Number((policy as Record<string, unknown>)[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function pollPeriodMinutes(policyValue: unknown, phase: PollPhase): number {
  const policy = policyObject(policyValue);
  return phase === 'FINAL_90'
    ? policyNumber(policy, 'final90Minutes', 5)
    : phase === 'APPROACHING'
      ? policyNumber(policy, 'approachingMinutes', 10)
      : policyNumber(policy, 'normalMinutes', 30);
}

export function pollBudget(
  policyValue: unknown,
  phase: PollPhase,
  minimumXCalls = DEFAULT_POLL_MAX_X_CALLS,
): number | null {
  if (phase !== 'FINAL_90') return null;
  const policy = policyObject(policyValue);
  const budget = Number(policy.final90Budget);
  return Number.isSafeInteger(budget) && budget >= minimumXCalls ? budget : null;
}

export function isPollDue(input: {
  policy: unknown;
  phase: PollPhase;
  now?: Date;
  checkpointEnd?: Date | null;
}): boolean {
  if (!input.checkpointEnd) return true;
  const now = (input.now ?? new Date()).getTime();
  const policy = policyObject(input.policy);
  const safetyLagMinutes = policyNumber(policy, 'safetyLagMinutes', 2);
  return (
    now - input.checkpointEnd.getTime() >=
    (pollPeriodMinutes(policy, input.phase) + safetyLagMinutes) * 60_000
  );
}

export function resolvePollPhase(
  policyValue: unknown,
  now = new Date(),
  minimumXCalls = DEFAULT_POLL_MAX_X_CALLS,
): PollPhase {
  const policy = policyObject(policyValue);
  const deadline = Date.parse(policy.deadlineAt ?? '');
  if (!Number.isFinite(deadline)) return 'NORMAL';
  const minutesToDeadline = (deadline - now.getTime()) / 60_000;
  const onDutyUntil = Date.parse(policy.editorOnDutyUntil ?? '');
  if (
    minutesToDeadline > 0 &&
    minutesToDeadline <= 90 &&
    policy.final90Enabled === true &&
    pollBudget(policy, 'FINAL_90', minimumXCalls) !== null &&
    Number.isFinite(onDutyUntil) &&
    onDutyUntil > now.getTime()
  )
    return 'FINAL_90';
  if (
    minutesToDeadline > 0 &&
    minutesToDeadline <= policyNumber(policy, 'approachingWindowMinutes', 360)
  )
    return 'APPROACHING';
  return 'NORMAL';
}

export function computePollWindow(input: {
  policy: unknown;
  phase: PollPhase;
  now?: Date;
  checkpointEnd?: Date | null;
}): { windowStart: Date; windowEnd: Date } {
  const now = input.now ?? new Date();
  const policy = policyObject(input.policy);
  const lagMinutes = policyNumber(policy, 'safetyLagMinutes', 2);
  const overlapMinutes = policyNumber(policy, 'overlapMinutes', 5);
  const maxCatchupMinutes = policyNumber(policy, 'maxCatchupMinutes', 360);
  const periodMinutes = pollPeriodMinutes(policy, input.phase);
  const windowEnd = new Date(now.getTime() - lagMinutes * 60_000);
  const earliest = new Date(windowEnd.getTime() - maxCatchupMinutes * 60_000);
  const checkpointStart = input.checkpointEnd
    ? new Date(input.checkpointEnd.getTime() - overlapMinutes * 60_000)
    : new Date(windowEnd.getTime() - periodMinutes * 60_000);
  const windowStart = checkpointStart < earliest ? earliest : checkpointStart;
  return { windowStart, windowEnd };
}
