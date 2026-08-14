-- Support bounded cleanup of expired non-active publication payloads.

CREATE INDEX dataset_publications_expired_idx
  ON ops.dataset_publications (expires_at)
  WHERE expires_at IS NOT NULL AND status IN ('retired', 'failed');
