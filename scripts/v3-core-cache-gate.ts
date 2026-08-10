const V3_CUTOVER_RUN_ID_PATTERN = /^v3-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$/;

export const V3_CORE_CACHE_APPROVAL_PREFIX = 'APPROVE_V3_CORE_CACHE ';

export function assertExactV3CoreCacheApproval(
  approval: string | undefined,
  runId: string | undefined,
): asserts runId is string {
  if (!runId || !V3_CUTOVER_RUN_ID_PATTERN.test(runId)) {
    throw new Error('CUTOVER_RUN_ID must be an exact v3 cutover run ID');
  }
  if (approval !== `${V3_CORE_CACHE_APPROVAL_PREFIX}${runId}`) {
    throw new Error(
      `V3_CORE_CACHE_APPROVAL must equal ${V3_CORE_CACHE_APPROVAL_PREFIX}<CUTOVER_RUN_ID>`,
    );
  }
}
