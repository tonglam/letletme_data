export const V3_LEGACY_DROP_APPROVAL_PREFIX = 'APPROVE_V3_LEGACY_DROP ';

const V3_LEGACY_DROP_MIGRATION_PATTERN = /^009[1-3]_.+\.sql$/;
const V3_CUTOVER_RUN_ID_PATTERN = /^v3-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,12}$/;

export type LegacyDropMigrationSelection = {
  files: string[];
  gatedFiles: string[];
  approval: string | undefined;
};

export function isV3LegacyDropMigration(filename: string): boolean {
  return V3_LEGACY_DROP_MIGRATION_PATTERN.test(filename);
}

export function selectV3LegacyDropMigrations(
  files: readonly string[],
  appliedFilenames: Iterable<string>,
  approval: string | undefined,
): LegacyDropMigrationSelection {
  const applied = new Set(appliedFilenames);
  const cleanupFiles = files.filter(isV3LegacyDropMigration);
  const appliedCleanupFiles = cleanupFiles.filter((filename) => applied.has(filename));
  const allCleanupApplied =
    cleanupFiles.length > 0 && appliedCleanupFiles.length === cleanupFiles.length;

  if (approval !== undefined) {
    const runId = approval.slice(V3_LEGACY_DROP_APPROVAL_PREFIX.length);
    if (
      !approval.startsWith(V3_LEGACY_DROP_APPROVAL_PREFIX) ||
      !V3_CUTOVER_RUN_ID_PATTERN.test(runId) ||
      approval !== `${V3_LEGACY_DROP_APPROVAL_PREFIX}${runId}`
    ) {
      throw new Error(
        `V3_LEGACY_DROP_APPROVAL must equal ${V3_LEGACY_DROP_APPROVAL_PREFIX}<CUTOVER_RUN_ID>`,
      );
    }
  }

  if (approval !== undefined || allCleanupApplied || cleanupFiles.length === 0) {
    return { files: [...files], gatedFiles: [], approval };
  }

  if (appliedCleanupFiles.length > 0) {
    throw new Error(
      'legacy cleanup is partially applied; the exact approval is required to resume',
    );
  }

  return {
    files: files.filter((filename) => !isV3LegacyDropMigration(filename)),
    gatedFiles: cleanupFiles,
    approval: undefined,
  };
}
