const PLAYER_PICKER_RPC_MIGRATION = '0043_create_graphql_read_rpcs.sql';

const DROP_LEGACY_PLAYER_PICKER_RPC =
  'DROP FUNCTION IF EXISTS public.get_players_for_picker(integer, integer);';

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
