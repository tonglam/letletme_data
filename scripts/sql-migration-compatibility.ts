const PLAYER_PICKER_RPC_MIGRATION = '0043_create_graphql_read_rpcs.sql';

const DROP_LEGACY_PLAYER_PICKER_RPC =
  'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);';

const LEGACY_TRANSACTION_CONTROL_MIGRATIONS = new Set([
  '0066_repair_fpl_team_archive_names.sql',
  '0067_repair_fpl_1718_stoke_name.sql',
]);

/**
 * Preconditions run in the same transaction as a still-pending historical
 * migration. This keeps the historical file immutable while allowing a
 * database that has the pre-0043 picker overload to apply 0043 successfully.
 * Databases that already ledgered 0043 instead receive the same replacement
 * from the normal 0052 tail migration.
 */
export function getSqlMigrationPreconditions(filename: string): readonly string[] {
  return filename === PLAYER_PICKER_RPC_MIGRATION ? [DROP_LEGACY_PLAYER_PICKER_RPC] : [];
}

/**
 * These two historical repair files contain BEGIN/COMMIT markers even though
 * the custom migrator already wraps every file in one transaction. Keep their
 * immutable source and checksum, but remove only the nested transaction
 * control while executing them on a fresh database.
 */
export function getSqlMigrationExecutionContents(filename: string, contents: string): string {
  if (!LEGACY_TRANSACTION_CONTROL_MIGRATIONS.has(filename)) return contents;

  return contents.replace(/^\s*BEGIN;\s*$/gm, '').replace(/^\s*COMMIT;\s*$/gm, '');
}
