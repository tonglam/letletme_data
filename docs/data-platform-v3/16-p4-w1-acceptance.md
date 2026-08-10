# P4 W1 Web contract and maintenance acceptance

Plan version: 3.2.4

Date: 2026-08-09

Web branch: `codex/data-platform-v3-contract`

Accepted Web commit: `7c7a2bcf4d355f0539f4e0ea7679d78d8253beb2`

Web predecessor: `c290d912dfc3756237d65794c47e78f2193771e8`

Accepted GraphQL G3 commit: `3b426383a13ddc4b2d1d22452216bfe77826e420`

## Outcome

W1 adopts the accepted Data Platform v3 GraphQL contract without adding a second data authority to
Web. All 32 exported Web GraphQL operations validate against the accepted G3 schema. The new
`playerStateProfile` operation has one root field and remains below the 200-node AST budget.

Player state is requested only when a user first opens the State tab. Each selected player owns an
independent request state; changing players cannot expose an in-flight result from the prior
selection. Reopening an already loaded tab does not refetch, including when GraphQL returned a
valid null. Comparison mode starts exactly one request per selected player. A valid null is shown as
unavailable rather than as zero, and missing Understat coverage is shown as an FPL-only result
rather than as an application failure.

Web adds no Understat client, key, writer, TTL, or cache. The accepted GraphQL 900-second success
cache and 60-second valid-null cache remain the only cache for this low-frequency feature.

## Maintenance contract

`MAINTENANCE_MODE=true` is an exact, server-only hard-cutover switch. While enabled:

- every document request returns a localized standalone maintenance document at the original URL
  with HTTP 503;
- the response carries `Cache-Control: private, no-store, no-transform`, a bounded `Retry-After`,
  `X-Robots-Tag: noindex, nofollow`, and the correct content language;
- `/api/graphql`, `/api/tournaments`, and `/api/tournaments/**` return a consistent 503 JSON error;
- Better Auth, Mini Program identity, and unrelated machine endpoints are not intercepted; and
- the document loads no application data, JavaScript, or external asset, so it cannot display stale
  v2 content during the hard cut.

The retry setting accepts integer seconds from 30 through 3,600 and otherwise falls back to 300.
English desktop and Simplified Chinese 390-pixel mobile journeys both passed accessibility and
horizontal-overflow checks. The Playwright readiness probe uses `/favicon.ico`, because a correct
503 response at `/` must not be mistaken for a failed test-server startup.

## Schema and ownership evidence

The durable validator contains all 32 Web operations, including the player-state, live snapshot,
event-live explain list, managed tournament, tournament metadata, and tournament participants
operations. Direct validation against the accepted G3 schema returned zero failures.

The W1 diff changes no dependency manifest, migration runner, Web database layer, Better Auth
implementation, or Auth API path. Exact direct `.from(` call counts remain 13 at both the Web
baseline and accepted W1 commit. Those existing calls remain Web-owned identity/profile/storage
operations. The diff adds no direct `fpl.*`, `competition.*`, `reporting.*`, `understat.*`, or
`bridge.*` reference.

The original dirty Web worktree remains on `web-adjustments` at
`cc8924c6b643fed9da88a57c90b921e78d0b5039`. The original dirty Data worktree remains on
`codex/understat-pipeline` at `93055dff53092b3236001e82a325007682626adf`; its existing
`.gitignore` modification was not touched.

## Test gates

| Gate | Result |
| --- | --- |
| Full Web unit suite | 207 passed, 2 database-only skipped, 0 failed; 209 total |
| ESLint | passed |
| TypeScript `--noEmit` | passed |
| Production build | passed |
| Normal Playwright suite | 16 passed, 2 maintenance-only skipped, 0 failed |
| Maintenance Playwright suite | 2 passed, 0 failed |
| Focused player-state journeys | 3 passed, 0 failed |
| Live 30-second polling repeat | 5 of 5 passed with 5 workers |
| GraphQL schema validation | 32 of 32 operations passed against accepted G3 |
| Player-state query budget | one root field; fewer than 200 AST nodes |
| Locale parity and maintenance unit tests | passed |
| Diff whitespace check | passed |

The build's missing-service-token messages and the normal E2E suite's missing-database warnings are
expected fixture-environment diagnostics. They do not change the passing exit status; deterministic
browser GraphQL fixtures do not weaken the production fail-closed rate-limit path.

No production database, Redis, service, deployment, DNS, identity data, or legacy object was
mutated.
