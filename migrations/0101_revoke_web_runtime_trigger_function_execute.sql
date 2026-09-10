-- Keep My FPL scope trigger and helper functions private to the Data writer.
-- The Web runtime role must not inherit their default PUBLIC EXECUTE privilege.
SET LOCAL lock_timeout = '5s';

REVOKE ALL ON FUNCTION competition.ensure_my_fpl_snapshot_scope_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.ensure_my_fpl_snapshot_scope_state() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_snapshot_scope_generation(text, smallint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_snapshot_scope_generation(text, smallint[]) TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_entry_scope_on_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_entry_scope_on_insert() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_entry_scope_on_delete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_entry_scope_on_delete() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_entry_scope_on_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_entry_scope_on_update() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_tournament_scope_on_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_tournament_scope_on_insert() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_tournament_scope_on_delete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_tournament_scope_on_delete() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_tournament_scope_on_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_tournament_scope_on_update() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_insert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_insert() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_delete() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_delete() TO letletme_data_writer;

REVOKE ALL ON FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION competition.bump_my_fpl_tournament_scope_on_tournament_update() TO letletme_data_writer;
