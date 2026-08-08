# P2 Source Contract Audit

Plan version: 3.2.2

Audit source: accepted B0 full restore, PostgreSQL 15.8, cutover run
`v3-20260808T160008Z-b9eddc0`.

Status: **ACCEPTED FOR DDL IMPLEMENTATION**

## Corrections required before implementation

### Entry history grain

`public.entry_history_infos` contains `entry_id`, a season label, total points, and overall rank. It
has no `event_id`. B0 contains 27 rows spanning 2011/12 through 2025/26. The v3 target is therefore
`competition.entry_season_histories` with primary key `(season_id, entry_id)`. Seasons before the
first FPL core archive are retained as reference-only dimension rows.

### Cup result identity

`public.entry_event_cup_results` has a stable integer `id` but no source `match_id`. v3 preserves
that ID as `source_result_id`; it does not manufacture a match identifier from opponent or event
fields.

### Player value reconstruction

- Historical `player_market_snapshots_history`: 245,146 rows.
- Historical `player_values_history`: 28,266 rows.
- Derivation rule: retain the first ordered snapshot per player and each later price change; map
  snapshot date to event deadline date; set the prior value and start/rise/fall classification.
- Historical derived rows: 28,266.
- Historical bidirectional set difference: 0.
- Current `player_values`: 573 start rows.
- Nine rows share the date and value of that player's first market capture and reconstruct
  directly; 564 rows predate their player's first market capture.
- Every value player has a market snapshot and every first observed market price equals the source
  start value; missing players: 0, price mismatches: 0.

`0085` may create exactly 564 `legacy_value_seed` market facts from those source rows, using the
source change date/value and earliest matching market metadata. Final source-to-view comparison
must be zero before legacy value tables become eligible for deletion.

## Confirmed source-key safety

The intended historical keys have zero duplicates for events, teams, players, phases, fixtures,
player event snapshots, gameweek stats, fixture stats, and market snapshots. Current market
snapshots also have zero duplicate `(snapshot_date, element_id)` keys.

## B0 authority values

- FPL 2025/26: 20 teams, 38 events, 841 players, 380 fixtures.
- Current 2026/27 snapshot: 20 teams, 38 events, 573 players, 380 fixtures.
- Understat: 4,560 matches, 6,424 player-season rows, 129,576 player-match-stat rows.
- Provider bridge: 1,909 entity links, all verified; 0 match links.

No production object or row was changed by this audit.
