export type MigrationHistoryInspection = {
  missing: string[];
  backdated: string[];
  latestApplied: string | null;
};

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
