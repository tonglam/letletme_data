export type MigrationHistoryInspection = {
  missing: string[];
  backdated: string[];
  latestApplied: string | null;
};

const legacyConvergenceMigrations = new Map<string, string>([
  ['0050_entry_event_result_rich_checkpoint.sql', '0072_entry_event_result_rich_checkpoint.sql'],
  ['0051_event_data_checked_at.sql', '0073_event_data_checked_at.sql'],
  ['0052_replace_player_picker_rpc.sql', '0074_replace_player_picker_rpc.sql'],
  ['0053_entry_transfer_source_checkpoint.sql', '0075_entry_transfer_source_checkpoint.sql'],
]);

/**
 * Keep old convergence filenames available for environments that already
 * ledgered them, while avoiding a backdated duplicate on environments whose
 * production tail is the restored 0050-0071 lineage.
 */
export function selectMigrationFilesForLedger(
  files: readonly string[],
  appliedFilenames: Iterable<string>,
): string[] {
  const applied = new Set(appliedFilenames);
  const available = new Set(files);
  return files.filter((filename) => {
    const replacement = legacyConvergenceMigrations.get(filename);
    return !replacement || !available.has(replacement) || applied.has(filename);
  });
}

export function inspectMigrationHistory(
  files: readonly string[],
  appliedFilenames: Iterable<string>,
): MigrationHistoryInspection {
  const applied = new Set(appliedFilenames);
  const local = new Set(files);
  const missing = [...applied].filter((filename) => !local.has(filename)).sort();
  const latestApplied = [...applied].sort().at(-1) ?? null;
  const backdated = latestApplied
    ? files.filter((filename) => !applied.has(filename) && filename < latestApplied)
    : [];

  return { missing, backdated, latestApplied };
}
