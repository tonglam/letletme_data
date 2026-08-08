export type MigrationHistoryInspection = {
  missing: string[];
  backdated: string[];
  latestApplied: string | null;
};

export type SqlMigrationLedger = 'ops' | 'public';

/**
 * The v3 ledger becomes authoritative only when the public compatibility name
 * is a view (0090-0092) or has been removed (0093+). Merely creating the ops
 * table in 0079 must not switch a partially applied migration run away from the
 * still-authoritative public ledger.
 */
export function selectSqlMigrationLedger(
  publicRelationKind: string | null,
  hasOpsLedger: boolean,
): SqlMigrationLedger {
  if (hasOpsLedger && (publicRelationKind === null || publicRelationKind === 'v')) {
    return 'ops';
  }
  return 'public';
}

const legacyConvergenceMigrations = new Map<string, string>([
  ['0050_entry_event_result_rich_checkpoint.sql', '0072_entry_event_result_rich_checkpoint.sql'],
  ['0051_event_data_checked_at.sql', '0073_event_data_checked_at.sql'],
  ['0052_replace_player_picker_rpc.sql', '0074_replace_player_picker_rpc.sql'],
  ['0053_entry_transfer_source_checkpoint.sql', '0075_entry_transfer_source_checkpoint.sql'],
]);
const legacyConvergenceSuccessors = new Map(
  [...legacyConvergenceMigrations].map(([legacy, successor]) => [successor, legacy]),
);

const isHistoricalProductionMigration = (filename: string): boolean =>
  /^(?:005[0-9]|006[0-9]|007[01])_/.test(filename) && !legacyConvergenceMigrations.has(filename);

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
  const hasLegacyConvergenceApplied = [...legacyConvergenceMigrations.keys()].some((filename) =>
    applied.has(filename),
  );
  const historicalFiles = files.filter(isHistoricalProductionMigration);
  const hasHistoricalLineageApplied = historicalFiles.some((filename) => applied.has(filename));

  return files.filter((filename) => {
    if (hasLegacyConvergenceApplied && !hasHistoricalLineageApplied) {
      // The old mainline convergence tail predates the separately deployed
      // Understat/FPL branch. Do not introduce that unrelated branch into an
      // environment that proves it never recorded any of its files.
      if (isHistoricalProductionMigration(filename)) return false;
    }
    const legacy = legacyConvergenceSuccessors.get(filename);
    if (legacy && applied.has(legacy) && !applied.has(filename)) return false;
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
