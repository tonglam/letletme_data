# P5 Rehearsal Run 6 - Correction/Discovery Replay

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: **complete correction/discovery replay; not eligible for P5-01 or P5-05**

Run 6 started from fresh PostgreSQL 15.8 and Redis 7 containers and is being completed as a
full correction/discovery replay. It cannot be promoted to a clean rehearsal because the Data,
GraphQL, and Web candidates changed after activation. Its purpose is now to close every remaining defect,
prove the corrected candidate against restored B0, and make Runs 7 and 8 mechanical replays.

## Accepted component gates

- encrypted B0 restored with exit 0 as the local Supabase image administrator;
- source role, relation, sequence, ACL, and business-hash diffs are zero;
- the restored 2025/26 season has 20 teams, 38 events, 841 players, and 380 fixtures;
- Redis queue relocation copied 296 keys with zero active jobs and an identical payload hash;
- all 17 activation migrations applied, the second pass applied zero, status is clean, and all
  three legacy-cleanup migrations remain gated;
- activation validation passed with 192 frozen relations, 192 mutation fences, and one active
  plan-3.2.5 publication;
- 51 quality checks and the full v3 hash reconciliation passed;
- dedicated Data and GraphQL runtime roles pass while administrator identities fail closed;
- the Data writer can read only the three approved migration-run columns, read/refresh exactly
  the two reporting MVs, and cannot read provenance, mutate migration state, read ordinary
  reporting views, modify MVs, or create reporting objects;
- the core cache published one immutable six-item plan-3.2.5 revision with non-expiring Data
  keys;
- GraphQL query/security caches use only the v3 namespace and accepted TTL classes, while restored
  legacy Understat queue keys remain isolated from query caching;
- restored-B0 Data integration passes 31 tests with four planned skips and zero failures; and
- public Web, core GraphQL, player, market, Data API, authenticated selections/tournament/auth,
  and health/readiness probes pass; and
- the terminal read-only hash gate matches activation for all 45 v3 relations, 199 frozen public
  relations, and 22 public sequences with three zero-byte diffs.

Durable evidence is under external `p5/rehearsal-6/`.

## Candidate defects found and corrected

### Data PostgreSQL idle reconnect

The production Bun build using `postgres@3.4.5` emitted a negative-timeout warning after an idle
reconnect. The candidate now uses `postgres@3.4.9`; lint, typecheck, 680 unit tests, production
build, and a post-idle readiness probe pass with zero negative-timeout warnings.

### GraphQL preseason live matches

`liveMatches(upcoming: true)` returned empty arrays when the core publication correctly had no
current event and marked GW1 as next. The candidate now resolves the flagged next event from the
request-pinned core snapshot. The focused regression and full GraphQL suite pass (315 pass, four
planned Understat integration skips, zero failures), and the restored-B0 runtime returns ten GW1
matches as `NEXT_EVENT`. The Web `/live/matches` page renders all ten with HTTP 200, no console
errors, and no failed responses.

Evidence:

- external `p5/rehearsal-6/logs/graphql-preseason-live-tests-valid.log`;
- external `p5/rehearsal-6/logs/graphql-preseason-live-runtime.json`; and
- external `p5/rehearsal-6/logs/browser-live-matches-preseason-fix.json` plus its screenshot.

### Web current-event authority and returning-user navigation

The Web candidate previously cached current/next events for 300 seconds independently of the
revisioned GraphQL cache. After the E2E publication changed revisions, `/data/selections` could
therefore retain a stale no-current-GW result. Web now performs this authority read with
`no-store`; the three formerly static consumers are explicitly dynamic, so GraphQL remains the
only durable query cache. The final production build is clean and the Web suite passes 211 tests
with four planned skips and zero failures.

The same E2E discovered that an already verified returning user was always sent back through FPL
binding after sign-in. The onboarding route now validates the persisted binding and redirects to
the sanitized requested destination, while unverified users, unsafe destinations, and redirect
loops remain guarded.

The final real-user journey signs in directly to `/tournament/list`, renders the tournament and
GW1 selections, renders live standings for two of two entries, signs out, and verifies the
protected-route redirect with no console errors or failed responses. Its signed-ingress weighted
GraphQL use is 77 of 120 units. A separate authenticated contract test proves two goalkeepers,
five defenders, five midfielders, three forwards, 15 total selected players, and exact 100%
selection/captain percentages without contaminating the user-journey rate budget.

Evidence:

- external `p5/rehearsal-6/logs/web-final-{lint,tests,typecheck,build}.log`;
- external `p5/rehearsal-6/logs/e2e-auth-tournament-selections-valid.json` and screenshots; and
- external `p5/rehearsal-6/logs/e2e-selection-contract-valid.json`.

## Operator/preflight findings retained for Run 7

- queue verification field naming and queue evidence wrapper;
- sequence evidence normalization format;
- zero-match shell counter behavior;
- GraphQL working-directory and environment preflight;
- production Data build selection;
- malformed authenticated Data request returns 400 at validation, not 422;
- BullMQ workers create short-lived `stalled-check` keys, so runtime queue acceptance must check
  queue state and allowed ephemeral keys instead of raw `DBSIZE` equality;
- live-match category assertion must account for preseason `nextEvent`;
- Web and Better Auth must use one canonical local `localhost` origin;
- PostgreSQL URL credentials must be URI encoded before service startup;
- Web typechecking is `npx tsc --noEmit` because the package has no `typecheck` script; and
- heavy authenticated GraphQL contract probes must use an isolated rate window rather than being
  inserted into the browser journey they are measuring.

These findings did not trigger a production mutation or a manual repair of restored business data.
They are nevertheless changes to the run procedure or candidate and therefore disqualify Run 6
from the clean-rehearsal slots.

## Corrected candidate closure

- GraphQL: `fa4a01243e5fcdc35b173f7b7fdfbc0c14a559f6`;
- Web: `e5ebac921635b0350fba1a62410d9416095bc562`; and
- Data: recorded after this evidence commit in external
  `p5/rehearsal-6/manifests/run6-candidate-manifest.json` to avoid commit self-reference.

Run 6 closes as a successful correction/discovery replay, not as either required clean rehearsal.
The separately owned Understat pipeline must be reconciled before the final candidate is frozen;
any resulting candidate change must be present in both clean Runs 7 and 8.

After those gates pass, start Run 7 from new PostgreSQL and Redis resources. Run 8 must replay the
same frozen candidates and procedure with matching target hashes and no candidate or runbook edit.
