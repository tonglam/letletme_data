-- Keep existing function bodies, owners, SECURITY INVOKER and ACLs intact.
-- Business references are already schema-qualified. Transition relations
-- old_rows/new_rows and local CTEs must remain unqualified.
SET LOCAL lock_timeout = '5s';
ALTER FUNCTION competition.bump_my_fpl_entry_scope_on_delete() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_entry_scope_on_insert() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_entry_scope_on_update() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_snapshot_scope_generation(text, smallint[]) SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_tournament_scope_on_delete() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_tournament_scope_on_insert() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_delete() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_insert() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_update() SET search_path = '';
ALTER FUNCTION competition.bump_my_fpl_tournament_scope_on_update() SET search_path = '';
ALTER FUNCTION competition.ensure_my_fpl_snapshot_scope_state() SET search_path = '';
ALTER FUNCTION ops.entry_is_eligible_for_event(integer, integer) SET search_path = '';
