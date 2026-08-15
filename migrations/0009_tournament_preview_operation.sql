ALTER TABLE competition.tournaments
  ADD COLUMN preview_payload_fingerprint text;

COMMENT ON COLUMN competition.tournaments.preview_payload_fingerprint IS
  'Canonical preview-create payload fingerprint used for idempotent recovery';
