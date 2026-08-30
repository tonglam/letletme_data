# Gameweek lifecycle monitoring checklist

This runbook is the repeatable operator contract for one FPL gameweek. It
separates the schedule from what actually happened, and treats source data,
durable rows, publication, and consumer visibility as separate checkpoints.
Use it for every event by replacing `seasonCode`, `eventId`, the official
deadline, and the first scheduled kickoff.

## Evidence fields

Record these fields for every stage. A queue enqueue is not source acquisition,
and an HTTP 200 is not publication or consumer acceptance.

| Field | Meaning | Evidence source |
| --- | --- | --- |
| Expected trigger | Canonical time/window at which the stage is eligible | Scheduler registry and event/fixture authority |
| Actual trigger | First scheduler obligation enqueue/claim or lifecycle transition | `ops.scheduler_obligations`, scheduler logs |
| First source data | First successful provider response for the stage | FPL request telemetry plus first source timestamp on durable rows |
| Durable result | Rows/checkpoint written and complete | `competition.*`, `fpl.events`, lifecycle/checkpoint repositories |
| Publication result | Active revision/pointer produced when the stage has a publication contract | `ops.dataset_publications`, Redis active pointer |
| Consumer result | The intended API/consumer can read that exact revision or rows | Internal API/read probe and response evidence |
| Completion | The stage's success predicate is satisfied | Scheduler obligation status and stage evidence |

Use UTC in persisted evidence and show AWST alongside it for the operator.
`source_first_at` must be the first successful source acquisition, not the job
completion timestamp. When request-level telemetry is unavailable, mark the
field as `unknown` and use the first durable row timestamp as a lower-bound
proxy rather than silently calling it exact.

## Stage checklist

The rows below are the expected lifecycle. Conditional rows must be recorded as
`N/A` with a reason when their eligibility condition is false; they must not be
silently omitted.

| Stage | Check item | Expected | Actual | Result / evidence |
| --- | --- | --- | --- | --- |
| 0. Authority baseline | Core event/fixture authority, production SHA, readiness | `bootstrap-static` and `fixtures` agree with `fpl.events`/`fpl.fixtures`; API/worker/scheduler/readiness green before deadline window |  |  |
| 0. Core data | Core snapshot publication | `core-snapshot` reads one bootstrap plus fixtures payload, atomically persists events/teams/players/phases/fixtures, activates `fpl:core`, and delivers the matching Redis pointer |  |  |
| 0. Core data | Current-event reconciliation | `core-current-reconcile` checks every 30 seconds; on a current-event/active-core mismatch it enqueues a complete core rebuild. A healthy check is not itself a new source fetch |  |  |
| 1. Deadline wait | Lifecycle state and absence of premature live/picks work | `PICKS_WAIT` from deadline until `deadline + 60m`; no live snapshot or live-picks refresh is expected |  |  |
| 2. Post-deadline checkpoint | `entry-picks` | Eligible at `deadline + 30m`; `entry-sync`; checkpoint covers known entries |  |  |
| 2. Post-deadline checkpoint | `entry-transfers` | Eligible at `deadline + 30m`; `entry-sync`; transfer checkpoint covers known entries |  |  |
| 2. Post-deadline checkpoint | `league-event-picks` | Eligible at `deadline + 30m`; `league-sync`; active league/tournament scopes converge |  |  |
| 2. Post-deadline checkpoint | `tournament-event-picks` | Eligible at `deadline + 30m`; `tournament-sync`; canonical picks are reused where already present |  |  |
| 2. Post-deadline checkpoint | `tournament-transfers-pre` | Eligible at `deadline + 30m`; `tournament-sync`; full transfer history is captured and checkpoint remains through `eventId - 1` |  |  |
| 3. First source acquisition | Picks and transfer source calls | First successful `/entry/{entryId}/event/{eventId}/picks/` and `/entry/{entryId}/transfers/` are timestamped separately; transfer sync may also read `/event/{eventId}/live/` for player points |  |  |
| 4. Checkpoint convergence | Row coverage and retries | Known eligible entry IDs have complete picks and transfer coverage; failed units are retried or explicitly evidenced |  |  |
| 5. Picks canary | `live-picks-refresh` / `PICKS_PROBE` | First probe at `deadline + 60m`; up to two canaries; only after accepted canary does remaining fan-out proceed |  |  |
| 6. Picks fan-out | Live picks child work | Remaining eligible entries are enqueued on the live-picks lane and converge to the same canonical entry-picks rows/publication contract |  |  |
| 7. Match-day prewarm | Official H2H, if eligible | From five minutes before a scheduled kickoff, official H2H is eligible only when lifecycle and match-window policy allow it |  |  |
| 8. First kickoff | Live snapshot and live picks sync | At/after first kickoff, probe `/event/{eventId}/live/` plus event fixtures; a scheduled kickoff alone is not proof that FPL marks a fixture `started` |  |  |
| 9. Active match window | Live facts, player stats, H2H | `LIVE_ACTIVE` while authoritative fixtures show an unfinished started match; 30-second V2 live polling, one-minute H2H when eligible, and a low-priority player-stat observer that does not gate the live publication |  |  |
| 10. Between fixtures | Settling and next fixture | `DAY_SETTLING`/`BETWEEN_FIXTURES`; retain the live publication and use the lower cadence until the next authoritative change |  |  |
| 11. Final review | `entry-results` / entry event results | After the post-match result boundary, fetch final picks plus event live for each eligible entry, persist `competition.entry_event_results` (and canonical picks/transfers as required), then pass the entry result checkpoint |  |  |
| 11. Final review | `league-event-results` | After the same post-match checkpoint, reconcile every active league/tournament entry against canonical entry results and complete the league result checkpoint |  |  |
| 11. Final review | `tournament-event-results` base report | After the final fixture's expected end (`latest kickoff + 2h`), fetch/reuse final source data, persist tournament event result inputs, and only then open the cascade |  |  |
| 11. Final review | Tournament result/report cascade | `points-race`, `battle-race`, `knockout`, `transfers-post`, and `cup-results` all succeed; `transfers-post` enqueues `selection-stats`; the six-role barrier then permits materialized-view refresh |  |  |
| 11. Final review | Tournament report read models | Refresh `reporting.tournament_entry_event_summaries` and `reporting.tournament_selection_stats` where applicable; verify `reporting.tournament_event_results` exposes the expected points/battle/knockout rows |  |  |
| 11. Final review | My FPL provisional snapshot | Daily/review orchestration produces a complete provisional snapshot; verify active manifest, outbox delivery, and consumer visibility |  |  |
| 12. Finalization | Event and publication boundary | `finished=true`, `data_checked=true`, all fixtures complete, final rows/publications/consumer probes pass; lifecycle becomes `FINALIZED` |  |  |
| 12. Finalization | My FPL final snapshot | Finalization reconciles the provisional scope against final event data; final manifest/outbox and consumer read must match the final boundary |  |  |
| 13. Handoff | Next-GW readiness | Current event, next event, core publication, source checkpoints, active pointers, and scheduler obligations are internally consistent |  |  |

## Source and artifact mapping

The post-deadline checkpoint has several jobs but one canonical entry data
model. The first two jobs are the primary source acquisition; the league and
tournament jobs resolve their eligible entries and reuse complete canonical
rows when possible.

| Work | Provider data | Durable artifact | Acceptance |
| --- | --- | --- | --- |
| Core authority | `bootstrap-static`; `fixtures/?event={eventId}` (the core job validates the full fixtures payload) | `fpl.events`, `fpl.teams`, `fpl.players`, `fpl.phases`, `fpl.fixtures`, `ops.dataset_publications` and Redis `fpl:core` pointer | One complete source revision is atomically persisted and the active DB/Redis publication identity matches |
| Entry picks | `/entry/{entryId}/event/{eventId}/picks/` | `competition.entry_event_picks`; entry picks checkpoint | Complete 15-player selection, captain/vice, multiplier, chip/transfer metadata where supplied |
| Entry transfers | `/entry/{entryId}/transfers/`; shared `/event/{eventId}/live/` points lookup in the entry transfer service | `competition.entry_event_transfers`; entry transfer checkpoint | Full history written for each required entry, with source freshness and transfer-point fields accounted for |
| League event picks | Canonical entry picks, resolved through active tournament/league membership | Existing canonical picks plus league/tournament trend scopes | Every eligible active competition entry is covered; reused rows are counted as reused, not refetched |
| Tournament event picks | Canonical entry picks and active tournament roster | Existing canonical picks plus tournament trend publication | Every eligible tournament entry is covered and ownership/captaincy trend publication advances |
| Tournament transfers pre | `/entry/{entryId}/transfers/` | Canonical transfer rows with `checkpointThroughEventId = eventId - 1` | Transfer history is captured after deadline without treating the current event as finalized |
| Live picks | `/entry/{entryId}/event/{eventId}/picks/` through canary then child scans | Canonical picks rows and live-picks publication contract | Canary is complete before fan-out; remaining units converge |
| Live snapshot | `/event/{eventId}/live/` and `fixtures/?event={eventId}` | Live publication, event-live/player-gameweek facts | Exact source revision is atomically published and readable |
| Official H2H | Official H2H standings/matches endpoints for eligible tournaments | Official H2H snapshot/publication | Match-window snapshot and standings publish atomically |
| Entry event results | Event picks plus event live, after post-match authority permits | `competition.entry_event_results`, canonical picks/transfers, entry result checkpoint | Every eligible entry has a fresh result row and the checkpoint succeeds |
| League event results | Canonical entry results and active league/tournament membership | League result rows/checkpoint | Every active scope converges; missing required units fail the checkpoint |
| Tournament event results | Event picks, event live, and transfer history for eligible tournament entries | Tournament points/battle/knockout result tables and result checkpoint | Base tournament inputs converge before any derived report is published |
| Tournament result reports | Durable tournament result tables | `reporting.tournament_event_results`, `reporting.tournament_entry_event_summaries`, `reporting.tournament_selection_stats` | Structure cascade completes, six-role barrier opens, materialized views refresh, and report consumers read the new rows |
| My FPL result snapshot | Core, player stats, entry and tournament outputs | `fpl:my-fpl`/active manifest, publication outbox, final snapshot | Manifest is complete, outbox delivered, and final consumer scope matches the event boundary |

## Dependency chains and acceptance boundaries

These chains are deliberately recorded separately. A downstream log line can
show that one unit was processed while the upstream batch, publication, or
consumer contract is still incomplete.

| Chain | Dependency flow | What must be recorded before calling it complete |
| --- | --- | --- |
| Core data | FPL `bootstrap-static` + full `fixtures` payload -> canonical `fpl.events`/teams/players/phases/fixtures -> active `ops.dataset_publications` row -> Redis `fpl:core` pointer -> GraphQL/API consumer | Source revision, canonical row counts, publication ID/revision, Redis pointer identity, and a consumer response for the same revision all agree |
| Entry data | Entry picks + transfer history (and event-live points lookup where required) -> `competition.entry_event_picks`/`entry_event_transfers` -> post-match `competition.entry_event_results` -> entry checkpoint | Every required entry is covered; picks are complete, transfers are accounted for, result rows contain the immutable event-picks payload, and the checkpoint has no missing units |
| League results | Canonical entry results -> active league/tournament membership resolution -> `competition.league_event_results` -> league result checkpoint/publication | All active scopes converge from canonical entry results; no report is accepted from a partial direct provider read |
| Tournament result inputs | Canonical entry results + picks + transfers + event-live points -> tournament points/battle/knockout/cup inputs | The base tournament result job has fresh source evidence and complete eligible-entry coverage before derived roles open |
| Tournament result report | Tournament result inputs -> `points-race` + `battle-race` + `knockout` + `transfers-post` + `cup-results`; `transfers-post` -> `selection-stats` -> six-role barrier -> report materializations/views -> tournament consumer | Each role has its own trigger/source/durable/completion record; the barrier is closed until every required role succeeds; refreshed report rows are read back from the intended consumer path |
| My FPL | Core + player stats + entry results + tournament outputs -> provisional snapshot -> outbox/active manifest -> final snapshot after event finalization | Provisional and final snapshots are distinguished, outbox delivery is evidenced, and the final consumer scope matches the event boundary |

For every arrow, keep the first successful source timestamp and the first
durable timestamp distinct. If a provider response is successful but the
canonical row count, publication identity, or consumer response does not move,
the upstream stage is `PARTIAL`, not `PASS`; downstream stages remain pending.

The finalization order for a gameweek is therefore:

```text
core authority
  -> picks/transfers checkpoints
  -> first kickoff live data
  -> live facts and player stats
  -> entry event results
  -> league/tournament result inputs
  -> tournament result cascade and report refresh
  -> My FPL provisional/final snapshot
  -> event/publication finalization
```

## GW-specific record template

Copy this block into the operator record for each event. Keep the original
timestamps and identifiers; do not replace them with rounded times.

```text
seasonCode:
eventId:
officialDeadlineUtc:
officialDeadlineAwst:
firstScheduledKickoffUtc:
firstScheduledKickoffAwst:
productionSha:

stage: post-deadline checkpoint
expectedTriggerUtc:
expectedJobs:
expectedQueues:
actualFirstTriggerUtc:
actualFirstJobId:
actualFirstRunId:
actualFirstSourceDataUtc:
sourceEndpoint:
durableRowsBefore -> after:
publicationBefore -> after:
consumerProbe:
completionUtc:
status: PASS | FAIL | PARTIAL | N/A
evidence:
notes:
```

Repeat the record for `entry-picks`, `entry-transfers`, each competition
checkpoint, `live-picks-refresh`, `live-snapshot`, official H2H, `entry-results`,
league/tournament results, every tournament cascade role, report/MV refresh,
My FPL provisional/final snapshot, and finalization.
For a stage with several parallel jobs, keep both the earliest actual trigger
and the per-job completion rows; the earliest one must not hide a later failed
job.

## Monitoring rules

1. Start with a read-only baseline: official event/fixture authority, current
   lifecycle state, production identity, readiness, runnable queue counts, and
   existing row/publication counts.
2. At each expected boundary, record the scheduler obligation transition and
   the first source response independently. The order to report is expected,
   actual trigger, first source data, durable result, publication/consumer,
   completion.
3. Treat BullMQ retained completed/failed counts as history. Current
   `waiting`, `delayed`, `active`, and durable obligation states are the live
   scheduling evidence.
4. Treat complete canonical rows and active publication pointers as the data
   acceptance boundary. Enqueue, health, heartbeat, or an HTTP 200 alone is
   insufficient.
5. For a batch job running inside a mutation scope, per-entry `sync completed`
   logs may be savepoint-local. An external read can correctly remain at zero
   until the root obligation commits. Record the first externally visible row
   timestamp only after root commit, and use the root obligation/checkpoint to
   decide whether the batch succeeded.
6. Never clear queues, bypass a failed checkpoint, or mark a stage complete to
   make the checklist green. Record retries, provider 503s, missing eligible
   entries, stale publication pointers, and consumer mismatches explicitly.
7. A later GW run reuses this checklist verbatim. Only the event authority,
   fixture timeline, eligible-entry counts, expected timestamps, and evidence
   identifiers change.
