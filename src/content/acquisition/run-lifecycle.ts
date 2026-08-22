export const ACQUISITION_RUN_STALE_AFTER_MS = 5 * 60_000;

export function isAcquisitionRunStale(input: {
  startedAt?: Date | null;
  createdAt: Date;
  now?: Date;
  staleAfterMs?: number;
}): boolean {
  const now = (input.now ?? new Date()).getTime();
  const anchor = (input.startedAt ?? input.createdAt).getTime();
  const staleAfterMs = input.staleAfterMs ?? ACQUISITION_RUN_STALE_AFTER_MS;
  return Number.isFinite(anchor) && now >= anchor && now - anchor >= staleAfterMs;
}
