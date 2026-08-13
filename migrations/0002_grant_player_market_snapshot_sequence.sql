-- player_market_snapshots.source_snapshot_id is the one runtime-generated key
-- backed by a regular sequence rather than an identity column. Table INSERT
-- privilege does not grant nextval() access to that sequence.
GRANT SELECT, USAGE
ON SEQUENCE fpl.player_market_snapshots_source_snapshot_id_seq
TO letletme_data_writer;
