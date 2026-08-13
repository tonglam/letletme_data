-- The Data runtime reads the derived rows immediately after persisting a
-- complete market snapshot. Keep this grant deliberately read-only.
GRANT SELECT
ON TABLE reporting.player_value_changes
TO letletme_data_writer;
