# Release fault matrix

This matrix is the PR7 regression contract. The unit suites run with the
preload fence and no network; rows marked integration require
`RUN_INTEGRATION=1` and a disposable PostgreSQL/Redis target. A passing queue
or process health check is not treated as proof of durable publication
correctness.

| Failure mode | Executable evidence | Required assertion |
| --- | --- | --- |
| Unit environment or provider reaches the network | `tests/unit/pr7-fault-matrix.test.ts`, `tests/unit/preload.ts` | Loopback synthetic endpoints, remote URL/credential scrubbing, and a throwing `fetch`; explicit adapter fixtures are set only by the test that owns them. |
| PostgreSQL commit followed by Redis failure | `tests/integration/my-fpl-snapshot-invalidation.test.ts` | DELETE remains successful after commit, the invalidation row is `FAILED`, and a later retry delivers it. |
| Duplicate outbox, expired lease, CAS race, malformed/missing pointer | `tests/integration/my-fpl-snapshot-invalidation.test.ts` | `SKIP LOCKED` claims once, expired work is reclaimed, newer revisions are never deleted, and malformed/missing pointers fail closed. |
| Manager checkpoint repeatedly fails | `tests/unit/manager-live-cache-only.test.ts`, `tests/unit/manager-live-worker-continuation.test.ts` | The configured retry budget is exhausted without advancing a non-durable cursor or reporting false completion. |
| Scheduler stale generation, lease, or dispatch deadline | `tests/unit/scheduler-obligation-fence.test.ts`, `tests/unit/scheduler-enqueue-recovery.test.ts`, `tests/unit/scheduler-plan-coalescing.test.ts` | Manual work is allowed, malformed/stale generations fail closed, and recovery uses the exact durable generation. |
| Provider partial response, timeout, or fallback | `tests/unit/fpl-client-resilience.test.ts`, `tests/unit/understat-client.test.ts`, `tests/unit/manager-live-fallback.test.ts` | Bounded retries and fallback preserve the last authoritative result; incomplete provider data cannot publish. |
| SIGTERM, repeated signal, shutdown timeout, or fatal exit | `tests/unit/shutdown-controller.test.ts`, `tests/unit/worker-runtime.test.ts` | Intake stops before drain, repeated signals coalesce, timeout/fatal paths exit non-zero, and resources close in order. |
| Invalid runtime configuration | `tests/unit/runtime-config-strict.test.ts`, `tests/unit/config-validation.test.ts` | Boolean typos, NaN, fractional integers, range violations, and invalid retry ordering fail startup; documented defaults remain unchanged. |
| Shell atomic replacement | `tests/unit/managed-env-shell.test.ts`, `scripts/check-shell-scripts.sh` | Symlinks/non-regular files are rejected, metadata is preserved, concurrent updates use separate temps, and failed replacement leaves the original intact. |

Run the unit portion with:

```bash
bun run coverage:critical
```

Run the cross-store rows only against a disposable environment:

```bash
RUN_INTEGRATION=1 bun test tests/integration/my-fpl-snapshot-invalidation.test.ts
```

The CI job uploads `coverage/lcov.info` as the `unit-lcov-*` artifact. No
whole-repository 80% threshold is used; the critical gates are declared in
`scripts/check-critical-coverage.ts` and are evaluated on executable source
lines and functions only.
