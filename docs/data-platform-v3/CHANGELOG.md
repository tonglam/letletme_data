# Data Platform v3 Plan Changelog

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
