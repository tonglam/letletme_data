# P5 Rehearsal Run 7 - Discovery Attempt

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: **closed as discovery; ineligible for either clean-rehearsal slot**

## Result

Run 7 restored encrypted B0 into fresh local PostgreSQL 15.8 and Redis resources, applied the
exact 21-file migration set twice, activated plan 3.2.5, published the immutable core cache, and
passed the 51-check data-quality gate. It cannot satisfy P5-01 or P5-05 because the operator
reprovisioned disposable runtime credentials after activation and a browser journey then found a
real Web/GraphQL candidate defect. No production mutation occurred.

The attempt is retained externally at `p5/rehearsal-7/`. A replacement clean Run 7 must use new
resources under `p5/rehearsal-7-clean/`; it may not reuse this database, Redis state, credentials,
or evidence as a clean result.

## Disqualifying discoveries

1. The three local runtime LOGIN passwords were not retained by the preactivation procedure.
   Their passwords had to be reprovisioned after activation. Role attributes, memberships,
   grants, schemas, and business data were unchanged, but this was an undocumented intervention.
2. The first maintenance-mode Web launch omitted `BACKEND_PROXY_SECRET`, so Better Auth returned
   HTTP 500 until the service was restarted with the complete environment contract.
3. `PlayerDirectoryPicker` still called generic `players(limit: 200)`. GraphQL correctly rejected
   that operation at weighted complexity 600, and the real Simplified Chinese player-stats page
   displayed `球员目录加载失败` when searching for Gabriel.

The first two findings change the operator procedure. The third changes the candidate. Any one of
them is sufficient to disqualify the attempt.

## Candidate correction

GraphQL now exposes `totalCount` on the existing `playersForPicker` payload, derives both the page
and total from the same immutable core snapshot, and versions its normally expiring picker query
cache. A limit-20 operation has weighted complexity 220; a roster-sized limit-100 operation is
rejected by the existing guard.

Web now uses only `playersForPicker`, with a 20-row server page and 200 ms debounce. Team,
position, and optional name filters are applied before result enrichment; the component no longer
downloads or loops through the full player roster.

| Component | Corrected commit | Tree |
| --- | --- | --- |
| GraphQL | `c1fbf895195aa199924d040cecc5c87e00dffb7d` | `4f5d752e0f277d3144afb0646a809c9023011c5e` |
| Web | `b8ab6134bbf30b0212581600f5643a08107ec648` | `5a0a90b271d6d22b36bdb41fe19d175b4a0b92df` |

Both remote branch heads matched the local commits. The GraphQL deploy image
`letletme-graphql:v3-candidate-c1fbf89-amd64` is `linux/amd64` with local image ID
`sha256:fa1551d3748a6be7b590296018c9b97b0e37645b318143484c548684bebd5334`.

## Correction verification

| Gate | Result |
| --- | --- |
| GraphQL full suite | 316 pass, 4 planned B0-only skips, 0 fail |
| GraphQL static gates | lint, format, typecheck, and Docker deployment build pass |
| Web full suite | 212 pass, 4 planned E2E skips, 0 fail |
| Web static/build gates | lint, typecheck, 46-page production build pass |
| Corrected GraphQL image smoke | 6 pass, 0 fail |
| Corrected Web public smoke | 11 pass, 0 fail |
| Direct Web proxy picker query | Gabriel element 4, `nextCursor=null`, `totalCount=1` |
| Fresh mobile browser search | one visible Gabriel result; one GraphQL request in 25 ms; no new console log |
| Player journey | detail and Player State tab render successfully |

The browser screenshot is external
`p5/rehearsal-7/screenshots/web-player-picker-fixed-mobile.png`. Full correction evidence is in
`p5/rehearsal-7/logs/player-picker-fix-regression.txt`.

## Restored-data and cleanup gate

After all services stopped:

- 197 frozen public business relations matched the activation baseline;
- all 22 public sequence states matched after format normalization;
- all 45 v3 business relations matched the deterministic Run 6 target; and
- the only unfiltered public-hash change was the expected migration-ledger transition from the
  preactivation ledger to preserved `sql_migrations_v2` plus the v3 ledger.

The host plaintext PostgreSQL dump, Redis RDB, and container plaintext dump were deleted by exact
path after verification. Encrypted B0 was untouched. All Run 7 containers are stopped and retained
only as disposable local forensic state.

## Replacement freeze and next gate

The Data SHA and deploy image produced after this evidence commit, the corrected GraphQL/Web
commits above, and the unchanged 21-file migration checksum list are frozen outside Git at
`p5/frozen-candidate-2/manifests/v3-candidate-manifest.json`. This avoids candidate self-reference.

Next, execute `rehearsal-7-clean` mechanically from fresh PostgreSQL and Redis resources. Run 8
must then use the identical manifest, procedure, target hashes, and credential staging with no
candidate or runbook edit. Production activation remains blocked.
