let playerRosterVersion = 0;

/**
 * Process-local generation for the complete current-season Player hash.
 * Player syncs advance it only after Redis replacement succeeds, so a live
 * snapshot cannot keep using a memoized roster that still contains removed
 * element IDs.
 */
export function getLiveSnapshotPlayerRosterVersion(): number {
  return playerRosterVersion;
}

export function invalidateLiveSnapshotPlayerRoster(): void {
  playerRosterVersion += 1;
}
