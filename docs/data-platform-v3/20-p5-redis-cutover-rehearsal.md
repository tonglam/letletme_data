# P5 Representative Redis Cutover Rehearsal

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: representative Redis restore, BullMQ relocation, scoped cleanup, and memory budget
accepted. The remaining PostgreSQL-size portion of P5-07 was subsequently accepted in
`21-p5-postcleanup-b1-restore.md`.

Accepted Data tooling commit: `6fc38cc0ec1df68612eafba31a0a195ecafac795`

## Restore input

The accepted encrypted B0 `redis.rdb.gpg` was restored into a new isolated Redis 7.0.15
container. Before loading it, both encrypted and decrypted SHA-256 checksums matched the B0
manifest, and `redis-check-rdb` passed:

| Check | Result |
| --- | --- |
| Encrypted SHA-256 | `c081273c52e9cf43e180aa1ed0e129ef6187eb9f83bcc47c698738c0e58ba29c` |
| Decrypted SHA-256 | `58b8871836bb24fc0d6718f7467d49b4ddf789c73782790b357bd750d9502252` |
| RDB version | Redis 7.0.15 |
| RDB keys | 493 read; 14 already expired at this later restore time |
| Restored keys | 479 |

The passphrase was read directly from the accepted macOS Keychain entry and was not printed,
written to a plaintext file, or added to a process argument. The current E2E cache and queue
containers were not touched.

## Representative baseline

The first post-restore inventory reported:

| Metric | Value |
| --- | ---: |
| Redis `used_memory` | 180,772,552 bytes |
| Per-key `MEMORY USAGE` sum | 177,692,882 bytes |
| DB0 keys | 479 |
| Data Understat cache | 110 keys / 173,790,827 bytes |
| BullMQ state | 296 keys |
| Expiring keys still alive | 6 |

This is representative of the accepted B0 contract. The difference from the earlier P0 sample is
expected: absolute expirations continued to elapse, while RDB reload can choose a different
in-memory encoding for large hashes.

## Formal cutover tooling

The rehearsal found that the repository had a safe cleanup function but no supported operator
entry point, and no implementation for the documented DB0-to-DB1 BullMQ relocation. Commit
`6fc38cc0ec1df68612eafba31a0a195ecafac795` adds one formal command:

```text
bun run redis:cutover copy-queues
bun run redis:cutover copy-queues --execute
bun run redis:cutover verify-queues
bun run redis:cutover cleanup --groups=<explicit-groups>
bun run redis:cutover cleanup --groups=<explicit-groups> --execute
```

Its safety contract is:

- cache and queue endpoints must be explicit and different;
- every operation uses bounded cursor-based `SCAN`;
- queue copy is dry-run by default and execution requires the exact dry-run payload manifest;
- existing identical queue keys are idempotent, while conflicting or unexpected target keys fail;
- queue payloads are compared with type-aware canonical logical hashes;
- cleanup is dry-run by default and requires the exact cutover run, legacy-drop approval, and
  exact dry-run key manifest;
- DB0 queue keys cannot be removed until their DB1 logical manifest is exact;
- cleanup uses bounded `UNLINK` only; no `DEL`, `FLUSHDB`, or `FLUSHALL` path exists; and
- post-cleanup queue verification is available independently from the now-empty DB0 source.

The canonical hash correction matters. The first real copy restored one BullMQ hash and then
failed closed because raw Redis `DUMP` bytes can change hash field serialization order after
`RESTORE`. DB0 remained intact. The accepted implementation compares strings, hashes, lists,
sets, sorted sets, and streams by canonical logical content instead. It resumed from the one-key
partial target without deleting it, proving idempotency.

## BullMQ DB0 to DB1 relocation

The accepted dry-run and execution results were:

| Metric | Result |
| --- | --- |
| Queue keys | 296 |
| Key manifest | `3a9acf9042087059a054bc0c73e25dbecf05bf568d675cecd3b8b23a5677d597` |
| Payload manifest | `68fed9e96cec9a596c5da6f55bc7ebe4d46c345f37b4e2c6870e95344bbdf768` |
| Resume state | 1 already exact; 295 copied |
| Verification | 296 already exact; 0 pending |

After DB0 cleanup, `verify-queues` independently reproduced the same 296-key and payload
manifests from DB1. Queue status/cardinality remained unchanged, including 71 completed data-sync
jobs, 100 completed and two failed Understat-player jobs, and 100 completed and four failed
Understat-team jobs.

## Scoped cleanup and negative gates

Three synthetic keys were added before cleanup: one `llm:v3:data:*`, one expiring
`llm:v3:gql:*`, and one unrelated namespace. They are not included in any deletion allowlist.

The exact cleanup groups were `dataCache`, `dataCoordination`, `graphqlCache`, and
`legacyQueueDb0`. One additional old `player_state` key expired naturally before the final dry-run,
so that immutable dry-run selected 478 keys with manifest:

`c1bafdc8c6fc3352bb5b0c198645ca959ee725ba75d39fbc7f8738b763e18401`

Before the accepted execution:

- missing run/approval failed with DB0 still at 481 keys;
- the exact local rehearsal approval plus a wrong key manifest failed with DB0 unchanged; and
- queue relocation was revalidated as 296 exact keys and zero pending.

The correctly gated local rehearsal unlinked exactly 478 of 478 matched keys. Its immediate
verification matched zero legacy keys. A second execution using the new empty manifest was a
successful zero-key no-op.

## Memory and preservation result

| Metric | Before | After | Difference |
| --- | ---: | ---: | ---: |
| Redis `used_memory` | 180,772,552 | 3,679,264 | -177,093,288 bytes |
| DB0 keys | 479 before sentinels | 3 | all three sentinels preserved |
| DB1 BullMQ keys | 0 | 296 | exact payload manifest preserved |

The reduction is about 169 MiB and exceeds the >=100 MB budget by about 69 MiB. A later inventory
read showed normal connection-overhead fluctuation at 3,718,960 bytes; the conclusion is
unchanged. DB0's three preserved keys use 264 bytes, while DB1's 296 queue keys use 1,834,406
bytes by per-key `MEMORY USAGE`.

Allocator RSS remained above logical `used_memory` immediately after asynchronous `UNLINK`, which
is expected fragmentation behavior and is not hidden as reclaimed resident memory. The plan's
same-server budget is evaluated using Redis `used_memory`; provider/RSS monitoring remains a P8
operational check.

## Verification

- focused Redis/approval tests: 13 passed, 0 failed;
- complete Data unit suite: 665 passed, 0 failed;
- ESLint: pass;
- TypeScript: pass; and
- production build: pass.

No production PostgreSQL, Redis, queue, application, or secret was accessed or changed by this
rehearsal.
