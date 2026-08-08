# Data Platform v3 Plan Changelog

## 3.1.0 - 2026-08-09

- Corrected `entry_history_infos` from an event-grain assumption to its actual season-summary
  grain and renamed the target physical table to `competition.entry_season_histories`.
- Added reference-only `fpl.seasons` rows for 2011/12 through 2015/16 so all preserved entry
  histories retain an authoritative `season_id` without fabricated core facts.
- Corrected the cup-result key: the source has no `match_id`, so v3 preserves the source result ID.
- Recorded the B0 value audit: 28,266 historical value rows reconstruct exactly from market
  snapshots; all 573 current start rows predate the first market capture and require one-to-one,
  provenance-marked seed snapshots before the final zero-mismatch gate.
- Renamed the normalized physical scoring table to `fpl.player_gameweek_scoring_items`, completing
  the plural physical-table naming rule.
- Updated the authoritative B0 Understat player-match count to 129,576.

## 3.0.0 - 2026-08-08

- Established a clean execution baseline from Data `origin/main` at `62f134a`.
- Recorded the production migration tail as `0078` and PostgreSQL as 15.8.
- Locked the six-schema ownership model, unified season tables, plural naming, and private Data API
  boundary.
- Locked the hard-cutover strategy with no dual-write, shadow reads, or v2 fallback.
- Locked Redis publication/query-cache ownership and removed the Data Understat cache.
- Added a pre-execution dirty-worktree isolation requirement. The existing
  `codex/understat-pipeline` checkout is not a v3 base and is handled by a separate task.
- Preserved an explicit approval gate before production legacy-object deletion.
