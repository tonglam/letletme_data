/**
 * Pure My FPL invalidation decisions shared by the Redis delivery adapter and
 * unit tests. Keeping the Redis result vocabulary here prevents an adapter
 * from silently accepting a new Lua result as a successful delivery.
 */

/** The only invalidation currently emitted by the tournament delete path. */
export const MY_FPL_SNAPSHOT_INVALIDATION_REASON = 'TOURNAMENT_DELETED' as const;

export type MyFplSnapshotInvalidationStatus =
  | 'absent'
  | 'deleted'
  | 'malformed_deleted'
  | 'different';

export function parseMyFplSnapshotInvalidationResult(
  result: unknown,
): MyFplSnapshotInvalidationStatus {
  const status = Array.isArray(result) ? result[0] : undefined;
  if (
    status !== 'absent' &&
    status !== 'deleted' &&
    status !== 'malformed_deleted' &&
    status !== 'different'
  ) {
    throw new Error(`My FPL Redis manifest invalidation failed: ${String(status)}`);
  }
  return status;
}

export function isSupportedMyFplInvalidationReason(reason: string): boolean {
  return reason === MY_FPL_SNAPSHOT_INVALIDATION_REASON;
}
