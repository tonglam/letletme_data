export const LIVE_FINAL_RETENTION_POLICY_VERSION = 'active-season-v1' as const;
export const LIVE_FINAL_RETENTION_EVIDENCE_SCHEMA_VERSION = 'live-final-retention-v2' as const;
export const LIVE_FINAL_RETENTION_STATUS_SCHEMA_VERSION = 'live-final-retention-status-v2' as const;

export const LIVE_FINAL_RETENTION_LEASE_MS = 14 * 24 * 60 * 60_000;
export const LIVE_FINAL_RETENTION_RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60_000;
export const LIVE_FINAL_RETENTION_CRITICAL_TTL_MS = 48 * 60 * 60_000;
export const LIVE_FINAL_RETENTION_PROOF_MAX_AGE_MS = 36 * 60 * 60_000;
export const LIVE_FINAL_RETENTION_CADENCE_MS = 24 * 60 * 60_000;

const LIVE_FINAL_RETENTION_SLOT_MINUTE = 17;

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function latestDailySlot(eventId: number, now: Date): Date {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error('Live final retention event ID must be a positive integer');
  }
  if (!validDate(now)) throw new Error('Live final retention clock must be valid');
  const slot = new Date(now);
  slot.setUTCHours((eventId - 1) % 24, LIVE_FINAL_RETENTION_SLOT_MINUTE, 0, 0);
  if (slot.getTime() > now.getTime()) {
    slot.setUTCDate(slot.getUTCDate() - 1);
  }
  return slot;
}

/**
 * Resolve one latest-authoritative daily checkpoint per finalized event.
 * A newly finalized event is eligible immediately rather than waiting for its
 * next distributed UTC slot.
 */
export function liveFinalRetentionDueAt(input: {
  eventId: number;
  dataCheckedAt: Date;
  now: Date;
}): Date {
  if (!validDate(input.dataCheckedAt)) {
    throw new Error('Live final retention data-checked timestamp must be valid');
  }
  const slot = latestDailySlot(input.eventId, input.now);
  return slot.getTime() < input.dataCheckedAt.getTime() ? new Date(input.dataCheckedAt) : slot;
}

export function liveFinalRetentionPeriodKey(eventId: number, dueAt: Date): string {
  if (!Number.isSafeInteger(eventId) || eventId <= 0 || !validDate(dueAt)) {
    throw new Error('Live final retention period identity is invalid');
  }
  return `live-final-retention-v2-${eventId}-${dueAt.toISOString().replace(/[-:.]/g, '')}`;
}

export function effectiveLiveFinalRetentionTtl(input: {
  observedTtlMs: number | null;
  observedAt: Date | null;
  now: Date;
}): number | null {
  if (
    input.observedTtlMs === null ||
    !Number.isFinite(input.observedTtlMs) ||
    input.observedTtlMs < 0 ||
    input.observedAt === null ||
    !validDate(input.observedAt) ||
    !validDate(input.now)
  ) {
    return null;
  }
  return Math.max(
    0,
    input.observedTtlMs - Math.max(0, input.now.getTime() - input.observedAt.getTime()),
  );
}
